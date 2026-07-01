import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4800', 10),
  apiKey: process.env.API_KEY || 'changeme',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'resource-hub.sqlite'),
};
