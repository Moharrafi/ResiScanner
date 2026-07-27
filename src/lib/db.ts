// Aiven MySQL Database Connection Configuration for inventoryaspal.vercel.app
const getDecodedPass = () => {
  try {
    return atob("QVZOU19SSV9oZG0tZXpvbjJiNE0xYllm");
  } catch {
    return "";
  }
};

export const DB_CONFIG = {
  host: "mysql-17a13883-xnoverse898-37d7.g.aivencloud.com",
  port: 26140,
  user: "avnadmin",
  password: getDecodedPass(),
  database: "inventory",
  ssl: {
    rejectUnauthorized: false,
  },
};
