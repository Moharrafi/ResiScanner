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
 * First discovers actual columns to avoid querying non-existent fields.
 */
async function getOrCreateProductId(
  connection: mysql.Connection,
  targetProductName: string,
  sz: string,
  knownColumns: string[],
): Promise<number | null> {
  // 1. Build a safe WHERE clause using only columns that actually exist
  const conditions: string[] = [];
  const params: any[] = [];

  if (knownColumns.includes("size")) {
    conditions.push("`size` = ?");
    params.push(sz);
  }
  if (knownColumns.includes("variant")) {
    conditions.push("`variant` = ?", "`variant` = ?");
    params.push(sz, `${sz}KG`);
  }
  if (knownColumns.includes("sku")) {
    conditions.push("`sku` LIKE ?");
    params.push(`%-${sz}KG`);
  }
  if (knownColumns.includes("name")) {
    conditions.push("`name` LIKE ?", "`name` LIKE ?");
    params.push(`%${sz}KG%`, `%${sz} KG%`);
  }

  if (conditions.length > 0) {
    const whereClause = conditions.join(" OR ");
    const [rows]: any = await connection.query(
      `SELECT \`id\` FROM \`inventory_products\` WHERE ${whereClause} LIMIT 1`,
      params
    );
    if (Array.isArray(rows) && rows.length > 0) {
      console.log(`[getOrCreateProductId] Found product ID ${rows[0].id} for size "${sz}"`);
      return rows[0].id;
    }
  }

  // 2. Fallback: map standard sizes (1,5,20,25) to row position in table
  const [allProducts]: any = await connection.query(
    `SELECT \`id\` FROM \`inventory_products\` ORDER BY \`id\` ASC`
  );
  if (Array.isArray(allProducts) && allProducts.length > 0) {
    const idxMap: Record<string, number> = { "1": 0, "5": 1, "20": 2, "25": 3 };
    const idx = idxMap[sz];
    if (idx !== undefined && allProducts[idx]) {
      console.log(`[getOrCreateProductId] Fallback: mapped size "${sz}" to product ID ${allProducts[idx].id} (row index ${idx})`);
      return allProducts[idx].id;
    }
  }

  // 3. Last resort: insert a new product row
  try {
    const fields: string[] = [];
    const values: any[] = [];

    if (knownColumns.includes("name")) {
      fields.push("`name`");
      values.push(`${targetProductName} ${sz}KG`);
    }
    if (knownColumns.includes("variant")) {
      fields.push("`variant`");
      values.push(`${sz}KG`);
    }
    if (knownColumns.includes("size")) {
      fields.push("`size`");
      values.push(sz);
    }
    if (knownColumns.includes("sku")) {
      fields.push("`sku`");
      values.push(`AEWB-${sz}KG`);
    }
    if (knownColumns.includes("stock")) {
      fields.push("`stock`");
      values.push(0);
    }
    if (knownColumns.includes("price")) {
      fields.push("`price`");
      values.push(0);
    }

    if (fields.length === 0) return null;

    const placeholders = values.map(() => "?").join(", ");
    const [insertRes]: any = await connection.query(
      `INSERT INTO \`inventory_products\` (${fields.join(", ")}) VALUES (${placeholders})`,
      values
    );
    console.log(`[getOrCreateProductId] Created new product for size "${sz}" with ID ${insertRes.insertId}`);
    return insertRes.insertId;
  } catch (insertErr) {
    console.error(`[getOrCreateProductId] Failed to create product for size "${sz}":`, insertErr);
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

      // Discover available tables
      const [tablesResult]: any = await connection.query("SHOW TABLES");
      const tableNames: string[] = Array.isArray(tablesResult)
        ? tablesResult.map((r: any) => Object.values(r)[0] as string)
        : [];

      console.log("[saveTransactionToDbFn] Tables found:", tableNames);

      const hasInventoryProducts = tableNames.includes("inventory_products");
      const hasStockOut = tableNames.includes("stock_out");
      const hasStockIn = tableNames.includes("stock_in");
      const hasProducts = tableNames.includes("products");
      const hasInventory = tableNames.includes("inventory");

      // Discover columns of inventory_products once (if it exists)
      let inventoryProductColumns: string[] = [];
      if (hasInventoryProducts) {
        const [cols]: any = await connection.query("DESCRIBE `inventory_products`");
        inventoryProductColumns = Array.isArray(cols) ? cols.map((c: any) => c.Field) : [];
        console.log("[saveTransactionToDbFn] inventory_products columns:", inventoryProductColumns);
      }

      await connection.beginTransaction();

      let recordCount = 0;
      const debugLog: string[] = [];

      for (const [sz, qty] of Object.entries(mappedSizes)) {
        if (qty <= 0) continue;

        let wrote = false;

        // 1. Dashboard tables: inventory_products + stock_out / stock_in
        if (hasInventoryProducts) {
          const productId = await getOrCreateProductId(connection, targetProductName, sz, inventoryProductColumns);

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
              debugLog.push(`stock_out: product_id=${productId}, sz=${sz}, qty=${qty}`);
              wrote = true;
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
              debugLog.push(`stock_in: product_id=${productId}, sz=${sz}, qty=${qty}`);
              wrote = true;
            }
          } else {
            debugLog.push(`SKIP sz=${sz}: could not find/create product_id`);
          }
        }

        // 2. Standalone products + inventory tables
        if (hasProducts) {
          const stockExpr = isOut ? "GREATEST(0, `stock` - ?)" : "`stock` + ?";
          await connection.query(
            `INSERT INTO \`products\` (\`name\`, \`size\`, \`stock\`, \`category\`)
             VALUES (?, ?, ?, 'Aspal')
             ON DUPLICATE KEY UPDATE \`stock\` = ${stockExpr}`,
            isOut ? [targetProductName, sz, 0, qty] : [targetProductName, sz, qty, qty]
          );
          wrote = true;
        }

        if (hasInventory) {
          const dbTypeLabel = isOut ? "keluar" : "masuk";
          await connection.query(
            `INSERT INTO \`inventory\` (\`product_name\`, \`size\`, \`quantity\`, \`type\`, \`sales_channel\`, \`created_at\`)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [targetProductName, sz, qty, dbTypeLabel, salesChannel, `${saveDate} 12:00:00`]
          );
          wrote = true;
        }

        if (wrote) recordCount++;
      }

      await connection.commit();

      const label = isOut ? "KELUAR" : "MASUK";
      const debugInfo = debugLog.length > 0 ? ` [${debugLog.join("; ")}]` : "";
      console.log(`[saveTransactionToDbFn] Committed ${recordCount} records.${debugInfo}`);

      return {
        success: recordCount > 0,
        message: recordCount > 0
          ? `Berhasil menyimpan ${recordCount} transaksi (${label}) ke database inventory!${debugInfo}`
          : `Tidak ada data yang ditulis ke database. Tables: [${tableNames.join(", ")}]. Debug: ${debugInfo || "no matching tables found"}`,
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
