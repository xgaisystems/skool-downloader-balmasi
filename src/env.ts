import fs from 'fs';
import { fileURLToPath } from 'url';

// Settings such as SKOOL_DOWNLOADS_DIR can live in a .env next to
// package.json. Imported first by the CLI, because some modules read their
// variables when they load; a variable already set in the environment wins.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
}
