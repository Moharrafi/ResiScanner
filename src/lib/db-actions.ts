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

export const saveTransactionToDbFn = createServerFn({ method: "POST" })
  .validator((data: SaveDbPayload) => data)
  .handler(async ({ data }) => {
    const { targetProductName, saveDate, actionType, salesChannel, mappedSizes } = data;
    const isOut = actionType === "out";
    const dbTypeLabel = isOut ? "keluar" : "masuk";
    const now = new Date();
    const timePart = now.toTimeString().split(" ")[0] ?? "12:00:00";
    const timestamp = `${saveDate} ${timePart}`;

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

      // 1. Ensure tables exist
      await connection.query(`
        CREATE TABLE IF NOT EXISTS \`products\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`name\` VARCHAR(255) NOT NULL,
          \`size\` VARCHAR(50) NOT NULL,
          \`stock\` INT NOT NULL DEFAULT 0,
          \`category\` VARCHAR(100) DEFAULT 'Aspal',
          \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY \`name_size_unique\` (\`name\`, \`size\`)
        );
      `);

      await connection.query(`
        CREATE TABLE IF NOT EXISTS \`inventory\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`product_name\` VARCHAR(255) NOT NULL,
          \`size\` VARCHAR(50) NOT NULL,
          \`quantity\` INT NOT NULL DEFAULT 0,
          \`type\` ENUM('in', 'out', 'masuk', 'keluar') DEFAULT '${dbTypeLabel}',
          \`sales_channel\` VARCHAR(100) DEFAULT '${salesChannel}',
          \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const sizesToExport = ["1", "5", "20", "25"];
      for (const sz of Object.keys(mappedSizes)) {
        if (!sizesToExport.includes(sz)) sizesToExport.push(sz);
      }

      const stockUpdateClause = isOut
        ? "`stock` = GREATEST(0, `stock` - VALUES(`stock`))"
        : "`stock` = `stock` + VALUES(`stock`)";

      let recordCount = 0;

      for (const sz of sizesToExport) {
        const qty = mappedSizes[sz] ?? 0;

        // Upsert product stock
        await connection.query(
          `INSERT INTO \`products\` (\`name\`, \`size\`, \`stock\`, \`category\`, \`updated_at\`) 
           VALUES (?, ?, ?, 'Aspal', ?)
           ON DUPLICATE KEY UPDATE ${stockUpdateClause}, \`updated_at\` = VALUES(\`updated_at\`)`,
          [targetProductName, sz, qty, timestamp]
        );

        // Record transaction in inventory table if quantity > 0
        if (qty > 0) {
          try {
            await connection.query(
              `INSERT INTO \`inventory\` (\`product_name\`, \`size\`, \`quantity\`, \`type\`, \`sales_channel\`, \`created_at\`)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [targetProductName, sz, qty, dbTypeLabel, salesChannel, timestamp]
            );
          } catch {
            // Fallback for legacy inventory table schema without sales_channel
            await connection.query(
              `INSERT INTO \`inventory\` (\`product_name\`, \`size\`, \`quantity\`, \`type\`, \`created_at\`)
               VALUES (?, ?, ?, ?, ?)`,
              [targetProductName, sz, qty, dbTypeLabel, timestamp]
            );
          }
          recordCount++;
        }
      }

      return {
        success: true,
        message: `Berhasil menyimpan data (${dbTypeLabel.toUpperCase()}) ke database Aiven! (${recordCount} varian terupdate)`,
      };
    } catch (error) {
      console.error("[saveTransactionToDbFn] Database error:", error);
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Gagal menyimpan ke database Aiven MySQL: ${errMsg}`,
      };
    } finally {
      if (connection) {
        try {
          await connection.end();
        } catch {
          // Ignore connection close errors
        }
      }
    }
  });
