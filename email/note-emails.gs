/* ============================================================================
   Icon Pools Team app: email each new pool note
   Runs in Google Apps Script under the app's Gmail account. Supabase sends it
   each new note on a pool; this emails it to the people listed below.

   SETUP (once, signed in to the app's Gmail account)
   1. Go to script.google.com > New project. Name it "Icon Pools note emails".
   2. Delete what's there, paste this whole file, and click Save.
   3. Put the two email addresses in RECIPIENTS below and click Save.
   4. Project Settings (gear icon) > Script Properties > Add script property:
        Property: SECRET    Value: (the secret word from step 1 of sql/07_note_emails.sql)
      Click Save script properties.
   5. Deploy > New deployment > gear icon > Web app.
        Description: Note emails
        Execute as: Me
        Who has access: Anyone
      Click Deploy, then Authorize access and allow it (Google will warn that the
      app isn't verified: click Advanced > Go to Icon Pools note emails).
   6. Copy the Web app URL (ends in /exec). It goes in sql/07_note_emails.sql.

   To change who gets the emails later: edit RECIPIENTS, Save, then
   Deploy > Manage deployments > pencil icon > Version: New version > Deploy.
   ========================================================================== */

const RECIPIENTS = [
  "first.person@example.com",
  "second.person@example.com"
];
const TIME_ZONE = "America/Chicago";
const APP_URL = "https://icon-pools-team.kelly-b05.workers.dev";

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (x) { return reply("bad request"); }
  const secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  if (!secret || d.secret !== secret) return reply("not allowed");

  const pool = String(d.pool || "a pool").slice(0, 100);
  const author = String(d.author || "Someone").slice(0, 100);
  const note = String(d.body || "").slice(0, 4000);
  const when = d.created_at
    ? Utilities.formatDate(new Date(d.created_at), TIME_ZONE, "EEE MMM d, h:mm a")
    : "";

  MailApp.sendEmail({
    to: RECIPIENTS.join(","),
    subject: "New note: " + pool,
    name: "Icon Pools App",
    body: note + "\n\n— " + author + (when ? ", " + when : "") +
          "\n\nPool: " + pool + "\nOpen the app: " + APP_URL
  });
  return reply("sent");
}

function reply(text) { return ContentService.createTextOutput(text); }

// Optional: run this once from the editor (select testEmail, click Run) to check it works.
function testEmail() {
  MailApp.sendEmail({ to: RECIPIENTS.join(","), subject: "Test: Icon Pools note emails",
    name: "Icon Pools App", body: "If you got this, note emails are set up." });
}
