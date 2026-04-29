// Event Capture — Scriptable Script
// Receives a base64 image string from a Shortcut (decodes, resizes, and re-encodes it),
// or an image from the Share Sheet or photo library, sends to n8n webhook for parsing.

const MAX_LONGEST_EDGE = 1000;

// Host and port are stored in the iOS Keychain — set them once by running this script
// manually with no image input, or via:
//   Keychain.set("n8n_host", "YOUR_HOST")
//   Keychain.set("n8n_port", "5678")  // optional, defaults to 5678
let n8nHost = Keychain.contains("n8n_host") ? Keychain.get("n8n_host") : null;
const n8nPort = Keychain.contains("n8n_port") ? Keychain.get("n8n_port") : "5678";

if (!n8nHost) {
  let alert = new Alert();
  alert.title = "Setup Required";
  alert.message = "Enter your n8n hostname (e.g. myhost.ts.net):";
  alert.addTextField("YOUR_HOST");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");
  let idx = await alert.present();
  if (idx === -1) {
    Script.complete();
    return;
  }
  n8nHost = alert.textFieldValue(0).trim();
  Keychain.set("n8n_host", n8nHost);
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
    // Called from Shortcut — input is base64 encoded by the Shortcut; decode, resize, re-encode.
    let raw = args.shortcutParameter;
    let cleanBase64 = raw.replace(/\s/g, ""); // strip any stray whitespace
    let data = Data.fromBase64String(cleanBase64);
    let img = data ? Image.fromData(data) : null;
    // If Scriptable can't decode the image (e.g. HEIC or unsupported format), send as-is without resizing
    base64 = img ? resizeAndEncode(img) : cleanBase64;

  } else if (args.images && args.images.length > 0) {
    // Called directly from Share Sheet — image passed directly
    base64 = resizeAndEncode(args.images[0]);

  } else {
    // Manual run — pick from photo library
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
