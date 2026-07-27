-- ============================================================
-- DATABASE SCHEMA & SEED FOR INVENTORYASPAL (https://inventoryaspal.vercel.app/)
-- Table: products / inventory
-- Menu: Inventory / Produk
-- ============================================================

CREATE TABLE IF NOT EXISTS `products` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `size` VARCHAR(50) NOT NULL,
  `stock` INT NOT NULL DEFAULT 0,
  `category` VARCHAR(100) DEFAULT 'Aspal',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `name_size_unique` (`name`, `size`)
);

CREATE TABLE IF NOT EXISTS `inventory` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `product_name` VARCHAR(255) NOT NULL,
  `size` VARCHAR(50) NOT NULL,
  `quantity` INT NOT NULL DEFAULT 0,
  `type` ENUM('masuk', 'keluar') DEFAULT 'masuk',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Template Default Produk (Aspal Emulsion Waterproofing Baru)
INSERT INTO `products` (`name`, `size`, `stock`, `category`) VALUES
('Aspal Emulsion Waterproofing Baru', '1', 0, 'Aspal'),
('Aspal Emulsion Waterproofing Baru', '5', 0, 'Aspal'),
('Aspal Emulsion Waterproofing Baru', '20', 0, 'Aspal'),
('Aspal Emulsion Waterproofing Baru', '25', 0, 'Aspal')
ON DUPLICATE KEY UPDATE `stock` = VALUES(`stock`);
