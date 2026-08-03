import * as crypto from "node:crypto";
import { decryptPayload, encryptPayload } from "@/lib/db/queries";
import { expect, test } from "vitest";

const generateValidFernetKey = () => {
  return crypto.randomBytes(32).toString("base64url");
};

test.beforeEach(() => {
  process.env.ENCRYPTION_KEY = generateValidFernetKey();
});

test.afterAll(() => {
  process.env.ENCRYPTION_KEY = originalEnvKey;
});

const originalEnvKey = process.env.ENCRYPTION_KEY;
type PayloadType = {
  accessToken: string;
};

test("should encrypt and decrypt token correctly with valid Fernet key", async () => {
  const payload = {
    accessToken: "1BQANOTEuMTA4LjU2LjEwOAG7Ol0aJiebrLnGuO4",
  };
  const credentialsEncrypted = encryptPayload(payload);
  const decryptedPayload = decryptPayload(credentialsEncrypted) as PayloadType;
  expect(payload.accessToken).toBe(decryptedPayload.accessToken);
});
