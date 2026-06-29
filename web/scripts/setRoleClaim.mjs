#!/usr/bin/env node
//
// Set a Firebase Auth custom-claim role on a user. Used to grant access to the
// WildWatch gallery's private slice (everything but public:true captures).
//
// Usage (from web/):
//   node --env-file=.env.local scripts/setRoleClaim.mjs --email <addr> --role <role>
//
// Roles: cam-viewer | hs-dev | family | admin
//
//   cam-viewer  — family / friends; full gallery, read-only
//   hs-dev      — students; gallery + dev dashboard
//   family      — Louie family; everything
//   admin       — site owner; everything + role management (this script)
//
// To LIST or REMOVE a role:
//   ... --email <addr> --show           prints current claims
//   ... --email <addr> --role none      clears the role claim
//
// The user must sign out and back in for the new claim to land in their ID
// token. (Firebase ID tokens are refreshed roughly hourly; signing out forces
// an immediate refresh.)

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const ALLOWED_ROLES = new Set(["cam-viewer", "hs-dev", "family", "admin"]);

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const key = k.slice(2);
    if (key === "show") {
      out.show = true;
      continue;
    }
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) continue;
    out[key] = v;
    i++;
  }
  return out;
}

function usage(msg) {
  if (msg) console.error("Error:", msg, "\n");
  console.error(
    "Usage:\n" +
      "  node --env-file=.env.local scripts/setRoleClaim.mjs --email <addr> --role <role>\n" +
      "  node --env-file=.env.local scripts/setRoleClaim.mjs --email <addr> --show\n" +
      "\n" +
      "Roles: cam-viewer | hs-dev | family | admin | none (clears)",
  );
  process.exit(2);
}

const args = parseArgs();
const email = args.email;
if (!email) usage("missing --email");
if (!args.show && !args.role) usage("missing --role or --show");
if (args.role && args.role !== "none" && !ALLOWED_ROLES.has(args.role)) {
  usage(`invalid role "${args.role}" — must be one of ${[...ALLOWED_ROLES].join(", ")} or "none"`);
}

initializeApp({ credential: applicationDefault() });
const auth = getAuth();

try {
  const user = await auth.getUserByEmail(email);

  if (args.show) {
    console.log(`uid:    ${user.uid}`);
    console.log(`email:  ${user.email}`);
    console.log(`claims: ${JSON.stringify(user.customClaims || {})}`);
    process.exit(0);
  }

  const current = user.customClaims || {};
  let next;
  if (args.role === "none") {
    const { role, ...rest } = current;
    next = rest;
  } else {
    next = { ...current, role: args.role };
  }

  await auth.setCustomUserClaims(user.uid, next);
  console.log(`✓ Set claims on ${email}:`);
  console.log(`  before: ${JSON.stringify(current)}`);
  console.log(`  after : ${JSON.stringify(next)}`);
  console.log(
    "\nNote: the user must sign out and back in for the new claim to take effect in their ID token.",
  );
} catch (err) {
  if (err.code === "auth/user-not-found") {
    console.error(`No Firebase Auth user found with email "${email}".`);
    console.error("They need to sign in once with Google first so a uid exists.");
    process.exit(1);
  }
  console.error("Failed:", err);
  process.exit(1);
}
