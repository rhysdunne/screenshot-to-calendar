// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: teal; icon-glyph: calendar-check;
// Event Capture — Scriptable Script
// Receives a base64 image string from a Shortcut (decodes, resizes, and re-encodes it),
// or an image from the Share Sheet or photo library, sends to n8n webhook for parsing.

const MAX_LONGEST_EDGE = 1000;

// Host and port are stored in the iOS Keychain — set them once by running this script
// manually with no image input, or via:
//   Keychain.set("n8n_host", "YOUR_HOST")
//   Keychain.set("n8n_port", "5678")  // optional, defaults to 5678
let n8nHost = Keychain.contains("n8n_host") ? Keychain.get("n8n_host") : null;
let n8nPort = Keychain.contains("n8n_port") ? Keychain.get("n8n_port") : "5678";

async function promptForConnection(currentHost, currentPort) {
  let alert = new Alert();
  alert.title = "n8n Connection";
  alert.message = "Enter your n8n hostname and port:";
  alert.addTextField("Hostname (e.g. myhost.ts.net)", currentHost || "");
  alert.addTextField("Port", currentPort || "5678");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");
  let idx = await alert.present();
  if (idx === -1) return false;
  let host = alert.textFieldValue(0).trim();
  let port = alert.textFieldValue(1).trim() || "5678";
  if (!host) {
    let err = new Alert();
    err.title = "Hostname Required";
    err.message = "Please enter a valid hostname.";
    err.addAction("OK");
    await err.present();
    return false;
  }
  Keychain.set("n8n_host", host);
  Keychain.set("n8n_port", port);
  n8nHost = host;
  n8nPort = port;
  return true;
}

if (!n8nHost) {
  let saved = await promptForConnection(null, "5678");
  if (!saved) { Script.complete(); return; }
}

const N8N_WEBHOOK_URL = `http://${n8nHost}:${n8nPort}/webhook/screenshot-to-calendar`;

function resizeAndEncode(img) {
  let { width, height } = img.size;
  let longestEdge = Math.max(width, height);
  if (longestEdge > MAX_LONGEST_EDGE) {
    let scale = MAX_LONGEST_EDGE / longestEdge;
    let newSize = new Size(Math.round(width * scale), Math.round(height * scale));
    let ctx = new DrawContext();
    ctx.size = newSize;
    ctx.drawImageInRect(img, new Rect(0, 0, newSize.width, newSize.height));
    img = ctx.getImage();
  }
  return Data.fromJPEG(img, 0.8).toBase64String();
}

async function main() {
  let base64;

  if (args.shortcutParameter && typeof args.shortcutParameter === "string") {
    // Called from Shortcut — image already resized by the Shortcut before encoding, so use as-is.
    // (Resizing in Scriptable would require decoding a ~2MB base64 string via args.shortcutParameter,
    // which exceeds the Shortcuts→Scriptable text size limit for large screenshots.)
    base64 = args.shortcutParameter.replace(/\s/g, "");
    if (!base64) {
      let alert = new Alert();
      alert.title = "No Image";
      alert.message = "The Shortcut passed an empty string. Check the Base64 Encode step.";
      alert.addAction("OK");
      await alert.present();
      return;
    }

  } else if (args.images && args.images.length > 0) {
    // Called directly from Share Sheet — image passed directly
    base64 = resizeAndEncode(args.images[0]);

  } else {
    // Manual run — show connection confirmation, then pick from photo library
    let confirm = new Alert();
    confirm.title = "n8n Connection";
    confirm.message = `${n8nHost}:${n8nPort}`;
    confirm.addAction("Run");
    confirm.addDestructiveAction("Change");
    confirm.addCancelAction("Cancel");
    let idx = await confirm.present();
    if (idx === -1) return;
    if (idx === 1) {
      let saved = await promptForConnection(n8nHost, n8nPort);
      if (!saved) return;
    }

    try {
      let img = await Photos.fromLibrary();
      base64 = resizeAndEncode(img);
    } catch (e) {
      let alert = new Alert();
      alert.title = "No Image";
      alert.message = "No image provided.";
      alert.addAction("OK");
      await alert.present();
      return;
    }
  }

  // POST to n8n webhook
  let payload = JSON.stringify({
    type: "image",
    image: base64
  });

  let req = new Request(N8N_WEBHOOK_URL);
  req.method = "POST";
  req.headers = { "Content-Type": "application/json" };
  req.body = payload;
  req.timeoutInterval = 120;

  try {
    let response = await req.loadJSON();

    if (!response || typeof response.status === "undefined") {
      let alert = new Alert();
      alert.title = "Unexpected Response";
      alert.message = "n8n returned an unexpected response. Check the workflow is active.";
      alert.addAction("OK");
      await alert.present();
      return;
    }

    let notif = new Notification();
    notif.title = "Event Captured";

    if (response.status === "ok") {
      notif.body = response.message || "Event created successfully";
      if (response.eventLink) {
        notif.openURL = response.eventLink;
      }
    } else {
      notif.body = "Error: " + (response.message || "Unknown error");
    }

    notif.schedule();

    // Show alert for immediate feedback
    let alert = new Alert();
    alert.title = response.status === "ok" ? "Event Created" : "Error";
    alert.message = response.message || JSON.stringify(response);
    if (response.eventLink) {
      alert.addAction("Open in Calendar");
      alert.addCancelAction("Done");
      let idx = await alert.present();
      if (idx === 0) {
        Safari.open(response.eventLink);
      }
    } else {
      alert.addAction("OK");
      await alert.present();
    }

  } catch (e) {
    let alert = new Alert();
    alert.title = "Request Failed";
    alert.message = e.message + "\n\nURL: " + N8N_WEBHOOK_URL;
    alert.addAction("OK");
    await alert.present();
  }
}

await main();
Script.complete();
