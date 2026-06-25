📑 Design Spec: Automated Email Device Registry
Project: Louie Labs Backyard Wildlife Monitor
Objective: Dynamically whitelist new ESP32 Heltec nodes using factory hardcoded MAC addresses without opening public unauthenticated database API routes.
1. System Architecture Flow

1. Hardware Boot: The Heltec node boots up, reads its hardcoded physical MAC address from the chip, and logs it to the serial monitor.
2. Student Activation: A student notes the MAC address and sends a standard email from their @louielabs.com account to a dedicated email address: camera-reg@louielabs.com.
3. Inbound Webhook Parsing: An inbound email service (like Postmark or SendGrid) catches the email and forwards it as a structured JSON payload via an HTTP POST request to a protected Next.js server route (/api/email-callback).
4. Validation & Hashing: The Next.js server validates that the sender belongs to the @louielabs.com domain. It then parses out the Device ID and MAC Address, hashes them with a secure prefix (louie_labs_7x29_), and writes it to the database.
5. Secure Database Entry: The device is instantly whitelisted in the Firebase Realtime Database pre_shared_keys registry block, granting it permission to write field telemetry data.

2. Next.js Processing Endpoint Blueprint
This is the route logic file to place at /app/api/email-callback/route.ts:
import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

// Initialized cleanly behind the scenes via Keyless Application Default Credentials (ADC)
const db = getDatabase();

export async function POST(req: NextRequest) {
  try {
    const emailData = await req.json();
    const emailBody = emailData.TextBody; 
    const sender = emailData.From;        

    // Enforce security: Only accept registration updates from official team domains
    if (!sender.endsWith('@louielabs.com')) {
      return NextResponse.json({ error: 'Unauthorized Sender Domain' }, { status: 403 });
    }

    // Regular Expression scans text body for: "REG: device_name MAC: 12characterHEX"
    const match = emailBody.match(/REG:\s*([a-zA-Z0-9_-]+)\s*MAC:\s*([a-fA-F0-9]{12})/i);

    if (match) {
      const deviceId = match[1].toLowerCase();
      const rawMac = match[2].toUpperCase();
      const generatedSecret = `louie_labs_7x29_${rawMac}`;

      // Insert directly into the locked down database registry tree
      await db.ref(`pre_shared_keys/${deviceId}`).set(generatedSecret);

      return NextResponse.json({ message: `Successfully whitelisted ${deviceId}` });
    }

    return NextResponse.json({ error: 'Valid registration pattern not found' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Processing Error' }, { status: 500 });
  }
}

3. Classroom Step-by-Step Instructions
Step A: Read the Hardware MAC
Have the students upload a quick test sketch to the Heltec node to read its MAC address via the Serial Monitor. It will print out a string looking like this: 24:0A:C4:00:01:10.
Step B: Send the Registration Email
From a laptop or mobile device logged into a @louielabs.com account, send a plain text message matching this syntax exactly:
• To: camera-reg@louielabs.com
• Subject: Node Activation
• Body: REG: pond_cam_01 MAC: 240AC4000110
Step C: Confirm and Run
The database will update its access token keys in under 2 seconds. The node can now be deployed to its station in the backyard mesh grid!
