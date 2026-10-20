import { authenticate } from "@google-cloud/local-auth";
import {
  calendarScope,
  defaultCredentialsPath,
  defaultTokenPath,
  saveRefreshToken
} from "./google-calendar.js";

async function run(): Promise<void> {
  const credentialsPath = process.env.GOOGLE_CALENDAR_CREDENTIALS ?? defaultCredentialsPath;
  const tokenPath = process.env.GOOGLE_CALENDAR_TOKEN ?? defaultTokenPath;
  const auth = await authenticate({ keyfilePath: credentialsPath, scopes: [calendarScope] });
  const refreshToken = auth.credentials.refresh_token;
  if (!refreshToken) {
    throw new Error("Google did not return a refresh token. Revoke the app's access and authorize again.");
  }
  await saveRefreshToken(credentialsPath, tokenPath, refreshToken);
  console.log(`Google Calendar authorization saved to ${tokenPath}.`);
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
