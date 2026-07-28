import { createServerFn } from "@tanstack/react-start";
import mysql from "mysql2/promise";
import { DB_CONFIG } from "@/lib/db";

export type SaveDbPayload = {
  targetProductName: string;
  saveDate: string;
  actionType: "out" | "in";
  salesChannel: string;
  mappedSizes: Record<string, number>;
};

/**
 * Dynamically finds or creates a product ID in `inventory_products` for the specified size.
 * Prevents foreign key constraint errors (e.g. stock_in_ibfk_1 / stock_out_ibfk_1).
 */
async function getOrCreateProductId(
  connection: mysql.Connection,
  targetProductName: string,
  sz: string,
): Promise<number | null> {
  try {
    // 1. Search for existing product matching size / variant / name
    const [rows]: any = await connection.query(
      `SELECT \`id\`, \`name\` FROM \`inventory_products\`
       WHERE \`size\` = ? OR \`variant\` = ? OR \`variant\` = ?
          OR \`name\` LIKE ? OR \`name\` LIKE ? OR \`sku\` LIKE ?`,
      [sz, sz, `${sz}KG`, `%${sz}KG%`, `% ${sz} %`, `%-${sz}KG`]
    );

    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0].id;
    }

    // 2. Fallback by index position if table already has standard 4 products
    const [allProducts]: any = await connection.query(
      `SELECT \`id\` FROM \`inventory_products\` ORDER BY \`id\` ASC`
    );
    if (Array.isArray(allProducts) && allProducts.length > 0) {
      const idxMap: Record<string, number> = { "1": 0, "5": 1, "20": 2, "25": 3 };
      const idx = idxMap[sz];
      if (idx !== undefined && allProducts[idx]) {
        return allProducts[idx].id;
      }
    }

    // 3. If missing, auto-insert new product into inventory_products
    const [cols]: any = await connection.query(`DESCRIBE \`inventory_products\``);
    const colNames = Array.isArray(cols) ? cols.map((c: any) => c.Field) : [];

    const fields: string[] = ["name"];
    const values: any[] = [`${targetProductName} ${sz}KG`];

    if (colNames.includes("variant")) {
      fields.push("variant");
      values.push(`${sz}KG`);
    }
    if (colNames.includes("size")) {
      fields.push("size");
      values.push(sz);
    }
    if (colNames.includes("sku")) {
      fields.push("sku");
      values.push(`AEWB-${sz}KG`);
    }
    if (colNames.includes("stock")) {
      fields.push("stock");
      values.push(0);
    }

    const placeholders = fields.map(() => "?").join(", ");
    const [insertRes]: any = await connection.query(
      `INSERT INTO \`inventory_products\` (${fields.map((f) => `\`${f}\``).join(", ")})
       VALUES (${placeholders})`,
      values
    );

    return insertRes.insertId;
  } catch (err) {
    console.error("[getOrCreateProductId] Error finding/creating product ID:", err);
    return null;
  }
}

export const saveTransactionToDbFn = createServerFn({ method: "POST" })
  .validator((data: SaveDbPayload) => data)
  .handler(async ({ data }) => {
    const { targetProductName, saveDate, actionType, salesChannel, mappedSizes } = data;
    const isOut = actionType === "out";

    let connection;
    try {
      connection = await mysql.createConnection({
        host: process.env.DB_HOST || DB_CONFIG.host,
        port: Number(process.env.DB_PORT || DB_CONFIG.port),
        user: process.env.DB_USER || DB_CONFIG.user,
        password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || DB_CONFIG.password,
        database: process.env.DB_NAME || DB_CONFIG.database,
        ssl: DB_CONFIG.ssl,
        connectTimeout: 10000,
      });

      await connection.beginTransaction();

      // Inspect available tables in the target database
      const [tablesResult]: any = await connection.query("SHOW TABLES");
      const tableNames: string[] = Array.isArray(tablesResult)
        ? tablesResult.map((r: any) => Object.values(r)[0] as string)
        : [];

      const hasInventoryProducts = tableNames.includes("inventory_products");
      const hasStockOut = tableNames.includes("stock_out");
      const hasStockIn = tableNames.includes("stock_in");
      const hasProducts = tableNames.includes("products");
      const hasInventory = tableNames.includes("inventory");

      let recordCount = 0;

      for (const [sz, qty] of Object.entries(mappedSizes)) {
        if (qty <= 0) continue;

        // 1. Handle dashboard tables: inventory_products & stock_out / stock_in
        if (hasInventoryProducts) {
          const productId = await getOrCreateProductId(connection, targetProductName, sz);

          if (productId) {
            if (isOut && hasStockOut) {
              await connection.query(
                `INSERT INTO \`stock_out\` (\`product_id\`, \`quantity\`, \`date\`, \`notes\`, \`customer\`)
                 VALUES (?, ?, ?, ?, ?)`,
                [productId, qty, saveDate, `Stok keluar dari PDF resi`, salesChannel]
              );
              await connection.query(
                `UPDATE \`inventory_products\` SET \`stock\` = GREATEST(0, \`stock\` - ?) WHERE \`id\` = ?`,
                [qty, productId]
              );
            } else if (!isOut && hasStockIn) {
              await connection.query(
                `INSERT INTO \`stock_in\` (\`product_id\`, \`quantity\`, \`date\`, \`notes\`, \`supplier\`)
                 VALUES (?, ?, ?, ?, ?)`,
                [productId, qty, saveDate, `Stok masuk dari PDF resi`, salesChannel]
              );
              await connection.query(
                `UPDATE \`inventory_products\` SET \`stock\` = \`stock\` + ? WHERE \`id\` = ?`,
                [qty, productId]
              );
            }
          }
        }

        // 2. Handle products & inventory tables if present
        if (hasProducts) {
          const stockExpr = isOut ? "GREATEST(0, `stock` - ?)" : "`stock` + ?";
          await connection.query(
            `INSERT INTO \`products\` (\`name\`, \`size\`, \`stock\`, \`category\`)
             VALUES (?, ?, ?, 'Aspal')
             ON DUPLICATE KEY UPDATE \`stock\` = ${stockExpr}`,
            isOut ? [targetProductName, sz, 0, qty] : [targetProductName, sz, qty, qty]
          );
        }

        if (hasInventory) {
          const dbTypeLabel = isOut ? "keluar" : "masuk";
          await connection.query(
            `INSERT INTO \`inventory\` (\`product_name\`, \`size\`, \`quantity\`, \`type\`, \`sales_channel\`, \`created_at\`)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [targetProductName, sz, qty, dbTypeLabel, salesChannel, `${saveDate} 12:00:00`]
          );
        }

        recordCount++;
      }

      await connection.commit();

      const label = isOut ? "KELUAR" : "MASUK";
      return {
        success: true,
        message: `Berhasil menyimpan ${recordCount} transaksi (${label}) ke database inventory!`,
      };
    } catch (error) {
      if (connection) {
        try { await connection.rollback(); } catch { /* ignore */ }
      }
      console.error("[saveTransactionToDbFn] Database error:", error);
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Gagal menyimpan ke database: ${errMsg}`,
      };
    } finally {
      if (connection) {
        try { await connection.end(); } catch { /* ignore */ }
      }
    }
  });

