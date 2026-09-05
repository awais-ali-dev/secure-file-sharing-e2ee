/**
 * Fails fast and loudly if required environment variables are missing —
 * instead of letting the AWS SDK throw a cryptic "Region is missing" (or
 * similar) error later, deep inside a request handler.
 *
 * This also catches the single most common cause of "I filled in .env but
 * it's still not working": the .env file existing on disk, looking
 * correct, but never actually being loaded — usually because the process
 * was started from the wrong working directory (dotenv looks for .env
 * relative to process.cwd(), not relative to this file), or because the
 * file is secretly named ".env.txt" (Windows hides known extensions by
 * default in Explorer, so a file can look like ".env" while actually
 * being ".env.txt").
 */

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_VARS = [
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'S3_BUCKET_NAME',
];

// Values straight out of .env.example — if these are still present, the
// user copied the template but never actually filled it in.
const PLACEHOLDER_VALUES = new Set([
  'your_access_key_id_here',
  'your_secret_access_key_here',
  'your-bucket-name-here',
]);

function validateEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  const envFileExists = fs.existsSync(envPath);

  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  const placeholders = REQUIRED_VARS.filter((key) => PLACEHOLDER_VALUES.has(process.env[key]));

  if (missing.length === 0 && placeholders.length === 0) return; // all good

  console.error('\n❌ Server cannot start — environment configuration problem.\n');
  console.error(`   Looked for .env at: ${envPath}`);
  console.error(`   .env file found on disk: ${envFileExists ? 'yes' : 'NO — this is almost certainly the problem'}\n`);

  if (!envFileExists) {
    console.error('   Fixes to try:');
    console.error('   1. Make sure you are running `npm start` / `npm run dev` from');
    console.error('      the SAME folder that directly contains .env (run `dir .env`');
    console.error('      in PowerShell to confirm it lists the file).');
    console.error('   2. On Windows, Explorer hides known file extensions by default,');
    console.error('      so a file can look like ".env" while actually being');
    console.error('      ".env.txt". Run `dir .env*` in PowerShell — if you see');
    console.error('      ".env.txt" instead of ".env", rename it:');
    console.error('      Rename-Item .env.txt .env\n');
  }

  if (missing.length > 0) {
    console.error(`   Missing environment variable(s): ${missing.join(', ')}`);
  }
  if (placeholders.length > 0) {
    console.error(`   Still set to placeholder value(s) from .env.example: ${placeholders.join(', ')}`);
    console.error('   Fill these in with your real AWS values.');
  }

  console.error('');
  process.exit(1);
}

module.exports = { validateEnv };
