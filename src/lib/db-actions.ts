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
 * Product ID mapping for "Aspal Emulsion Waterproofing Baru" in `inventory_products` table.
 * These IDs match the existing rows in the inventoryaspal dashboard database.
 *
 *   id=7  -> AEWB-1KG  (variant '1',  price 35000)
 *   id=8  -> AEWB-5KG  (variant '5',  price 140000)
 *   id=9  -> AEWB-20KG (variant '20', price 720000)
 *   id=10 -> AEWB-25KG (variant '25', price 890000)
 */
const PRODUCT_ID_MAP: Record<string, number> = {
  "1": 7,
  "5": 8,
  "20": 9,
  "25": 10,
};

export const saveTransactionToDbFn = createServerFn({ method: "POST" })
  .validator((data: SaveDbPayload) => data)
  .handler(async ({ data }) => {
    const { saveDate, actionType, salesChannel, mappedSizes } = data;
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

      let recordCount = 0;

      for (const [sz, qty] of Object.entries(mappedSizes)) {
        if (qty <= 0) continue;

        const productId = PRODUCT_ID_MAP[sz];
        if (!productId) continue; // skip unknown sizes

        if (isOut) {
          // INSERT into stock_out table (used by dashboard for OUT transactions)
          await connection.query(
            `INSERT INTO \`stock_out\` (\`product_id\`, \`quantity\`, \`date\`, \`notes\`, \`customer\`)
             VALUES (?, ?, ?, ?, ?)`,
            [productId, qty, saveDate, `Stok keluar dari PDF resi`, salesChannel]
          );

          // Update inventory_products stock (decrease)
          await connection.query(
            `UPDATE \`inventory_products\` SET \`stock\` = \`stock\` - ? WHERE \`id\` = ?`,
            [qty, productId]
          );
        } else {
          // INSERT into stock_in table (used by dashboard for IN transactions)
          await connection.query(
            `INSERT INTO \`stock_in\` (\`product_id\`, \`quantity\`, \`date\`, \`notes\`, \`supplier\`)
             VALUES (?, ?, ?, ?, ?)`,
            [productId, qty, saveDate, `Stok masuk dari PDF resi`, salesChannel]
          );

          // Update inventory_products stock (increase)
          await connection.query(
            `UPDATE \`inventory_products\` SET \`stock\` = \`stock\` + ? WHERE \`id\` = ?`,
            [qty, productId]
          );
        }

        recordCount++;
      }

      await connection.commit();

      const label = isOut ? "KELUAR" : "MASUK";
      return {
        success: true,
        message: `Berhasil menyimpan ${recordCount} transaksi (${label}) ke database inventory! Cek dashboard admin.`,
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
