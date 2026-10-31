import type { Metadata } from "next";

import { LEGAL_CONTACT_EMAIL, LEGAL_ENTITY, LEGAL_UPDATED } from "../legal";

export const metadata: Metadata = { title: "Data Deletion Instructions" };

export default function DataDeletionPage() {
  return (
    <>
      <h1>Data Deletion Instructions</h1>
      <p>Last updated: {LEGAL_UPDATED}</p>

      <p>
        If you have messaged {LEGAL_ENTITY} on WhatsApp, Facebook Messenger or Instagram,
        you can ask us to delete the data we hold about you: your messages, profile
        details (name, username, profile picture, phone number or page-scoped ID) and
        any notes our staff added.
      </p>

      <h2>How to request deletion</h2>
      <ol>
        <li>
          Email <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a> with
          the subject &quot;Data deletion request&quot;.
        </li>
        <li>
          Tell us how you contacted us: your WhatsApp number, your Facebook name, or your
          Instagram username. This lets us find your conversation.
        </li>
        <li>
          Alternatively, send the message &quot;Delete my data&quot; to us in the same
          WhatsApp, Messenger or Instagram chat.
        </li>
      </ol>

      <h2>What happens next</h2>
      <p>
        We will confirm your request and delete your contact record and conversation
        history from our CRM within 30 days. We will let you know when it is done. We may
        keep a minimal record if the law requires us to.
      </p>

      <h2>Removing our app&apos;s access on Facebook</h2>
      <p>
        You can also remove any access you gave our app in Facebook: go to{" "}
        <strong>Settings &amp; privacy → Settings → Apps and websites</strong> (or{" "}
        <strong>Business integrations</strong>), find the app and click{" "}
        <strong>Remove</strong>.
      </p>

      <p>
        See also our <a href="/privacy">Privacy Policy</a>.
      </p>
    </>
  );
}
