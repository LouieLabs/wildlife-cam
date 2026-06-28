> ⚠️ **SUPERSEDED — DO NOT SHIP THE RULES BELOW.**
> The `".read": true` rule in this document makes the *entire* database — including
> the `pre_shared_keys` secrets — readable by anyone on the internet, which
> defeats the write protection. The MAC-derived `louie_labs_7x29_[MAC]` "secret"
> is also guessable. **The live, locked-down rules are in
> [`web/firebase-rules.json`](web/firebase-rules.json)**, and the secure design is
> documented in [`web/README.md`](web/README.md). This file is kept only as a
> record of what we moved away from and why.

# 📑 Security Spec: Firebase Realtime Database Rule Architecture
**Project:** Louie Labs Backyard Wildlife Monitor  
**Objective:** Secure the database from broad public write access while keeping the field firmware on the Heltec MCU lightweight and keyless.

---

## 1. The Core Strategy
To avoid downloading long-lived, dangerous static JSON key files (which are blocked by our Google Cloud organization security policies), we handle security entirely through **Dynamic Hardware-MAC Whitelisting**. 

Instead of hardcoding a master password into every camera node, each Heltec node dynamically generates its own cryptographic secret based on its factory hardcoded physical MAC address. The Firebase Realtime Database then checks incoming data against an authorized `pre_shared_keys` registry block before allowing any changes.

---

## 2. Firebase Realtime Database Rules Configuration
Place these rules into your Firebase Console under the **Rules** tab, or save them in your repository root as `firebase-rules.json`:

```json
{
  "rules": {
    // Allows our Next.js web dashboard to freely read and display telemetry
    ".read": true,
    
    "devices": {
      "$device_id": {
        // Only allow a node to write to its sandbox if its secret matches the whitelisted registry key
        ".write": "newData.child('secret').val() === root.child('pre_shared_keys').child($device_id).val()"
      }
    }
  }
}

3. The Data Payload Structure
When a Heltec camera node transmits its status or battery metrics over the Sub-1GHz Wi-Fi HaLow mesh network, it must structure its JSON payload to match the expected rule schema exactly:
{
  "status": "online",
  "battery": 92, 
  "secret": "louie_labs_7x29_240AC4000110" 
}

• status: Current operational state of the camera node.
• battery: Onboard battery life percentage calculated by the MCU's analog-to-digital converter pin.
• secret: The unique signature combining our project token and the device's clean MAC address (louie_labs_7x29_[MAC_ADDRESS]).
(If the secret value missing or does not match the database registry, Firebase immediately drops the write request with an HTTP 403 Forbidden error, keeping the system safe from tampering).
4. Why This Approach Wins
• Classroom Scalability: Students don't need to manually hardcode unique passwords per node or handle vulnerable JSON files. They simply compile the firmware, and the MCU handles its own identity generation natively.
• Blast Radius Isolation: If a physical camera node is lost or stolen from the backyard grid, you only have to delete its entry in the pre_shared_keys path. The rest of the network continues working uninterrupted.
5. Automated Email Device Registry
Objective: Dynamically whitelist new ESP32 Heltec nodes using factory hardcoded MAC addresses without opening public unauthenticated database API routes.
Architecture Flow
1. Hardware Boot: The Heltec node boots up, reads its hardcoded physical MAC address from the chip, and logs it to the serial monitor.
2. Student Activation: A student notes the MAC address and sends a standard email from their @louielabs.com account to a dedicated email address: camera-reg@louielabs.com.
3. Inbound Webhook Parsing: An inbound email service (like Postmark or SendGrid) catches the email and forwards it as a structured JSON payload via an HTTP POST request to a protected Next.js server route (/api/email-callback).
4. Validation & Hashing: The Next.js server validates that the sender belongs to the @louielabs.com domain. It then parses out the Device ID and MAC Address, hashes them with a secure prefix (louie_labs_7x29_), and writes it to the database.
5. Secure Database Entry: The device is instantly whitelisted in the Firebase Realtime Database pre_shared_keys registry block, granting it permission to write field telemetry data.
6. Next.js Processing Endpoint Blueprint
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

7. Classroom Step-by-Step Instructions
Step A: Read the Hardware MAC
Have the students upload a quick test sketch to the Heltec node to read its MAC address via the Serial Monitor. It will print out a string looking like this: 24:0A:C4:00:01:10.
Step B: Send the Registration Email
From a laptop or mobile device logged into a @louielabs.com account, send a plain text message matching this syntax exactly:
• To: camera-reg@louielabs.com
• Subject: Node Activation
• Body: REG: pond_cam_01 MAC: 240AC4000110
Step C: Confirm and Run
The database will update its access token keys in under 2 seconds. The node can now be deployed to its station in the backyard mesh grid!
