import type { Metadata } from "next";

import { LEGAL_CONTACT_EMAIL, LEGAL_ENTITY, LEGAL_UPDATED } from "../legal";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPolicyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p>Last updated: {LEGAL_UPDATED}</p>

      <p>
        This policy explains how {LEGAL_ENTITY} (&quot;we&quot;, &quot;us&quot;) handles
        personal data in our customer messaging system at wa.focasedu.online (the
        &quot;CRM&quot;). We use the CRM to talk to students and customers who contact us
        on WhatsApp, Facebook Messenger and Instagram. The CRM is used only by our own
        staff and is not offered to other businesses.
      </p>

      <h2>Data we collect</h2>
      <p>When you message us on WhatsApp, Messenger or Instagram, we receive and store:</p>
      <ul>
        <li>Your messages to us and our replies, including photos, videos, audio and files you send.</li>
        <li>
          Your WhatsApp phone number and profile name, or your Messenger / Instagram
          page-scoped ID, name, Instagram username and profile picture, as provided by Meta.
        </li>
        <li>Message status information (delivered, read) and reactions.</li>
        <li>Notes, tags and other details our staff add while helping you.</li>
      </ul>
      <p>
        We only receive messages from conversations that you start, and from people who
        message our own WhatsApp number, Facebook Page (FOCAS Edu) or Instagram account
        (@focasedu).
      </p>

      <h2>How we use it</h2>
      <ul>
        <li>To read and reply to your messages and provide the support or information you asked for.</li>
        <li>To keep a history of your conversation so any team member can help you.</li>
        <li>
          To send automated replies (for example, answers to common questions) in
          conversations you started.
        </li>
        <li>
          On WhatsApp only, to send messages you agreed to receive. You can opt out at any
          time by asking us.
        </li>
      </ul>
      <p>We do not sell your data and we do not use it for advertising.</p>

      <h2>Who we share it with</h2>
      <p>Your data is shared only with service providers that run the CRM for us:</p>
      <ul>
        <li>Meta Platforms (WhatsApp, Messenger, Instagram), which delivers the messages.</li>
        <li>Supabase, which stores the CRM database and media files.</li>
        <li>Hostinger, which hosts the CRM server.</li>
        <li>
          If automated AI replies are turned on, the text of your conversation is sent to
          our AI provider to generate a reply.
        </li>
      </ul>
      <p>We may also disclose data where required by law.</p>

      <h2>How long we keep it</h2>
      <p>
        We keep conversations for as long as needed to support you and meet our legal
        obligations, or until you ask us to delete them.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask us to access, correct or delete your data at any time. See our{" "}
        <a href="/data-deletion">data deletion instructions</a>, or email us at{" "}
        <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
      </p>

      <h2>Security</h2>
      <p>
        Data is sent over encrypted connections (HTTPS). Access tokens are stored
        encrypted, and only our authorised staff can sign in to the CRM.
      </p>

      <h2>Contact</h2>
      <p>
        {LEGAL_ENTITY}, India.
        <br />
        Email: <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>
      </p>
    </>
  );
}
