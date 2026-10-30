/**
 * Regression tests for EWS SOAP response parsing (EwsSource.ts).
 *
 * Bugs fixed:
 * 1. Regex `<t:Subject>([^<]*)</t:Subject>` returned "" for any subject containing
 *    an encoded entity (`&lt;`, `&amp;`) and never decoded entities, so Arabic/HTML
 *    subjects reached Postgres mangled or empty.
 * 2. Regex `<t:From>[\s\S]*?<t:EmailAddress>` was unbounded: when a message had no
 *    From block it grabbed the FIRST address anywhere in the item (a To/Cc recipient),
 *    mis-attributing the sender of clinical approvals.
 * 3. ResponseElementError blocks (e.g. ErrorItemNotFound for a moved/deleted id) were
 *    matched as messages, silently producing garbage records instead of being skipped.
 */
import { describe, it, expect } from 'vitest';
import { parseGetItemsResponse } from '../src/mail/adapters/ewsXml';

const ENVELOPE = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header/>
  <soap:Body>
    <m:GetItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
      <m:ResponseMessages>
        <m:GetItemResponseMessage ResponseClass="Success">
          <m:ResponseCode>NoError</m:ResponseCode>
          <m:Items>${inner}</m:Items>
        </m:GetItemResponseMessage>
      </m:ResponseMessages>
    </m:GetItemResponse>
  </soap:Body>
</soap:Envelope>`;

const MESSAGE = `<t:Message xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <t:ItemId Id="ITEM%5f1" ChangeKey="CK1"/>
  <t:Subject>Re: &lt;urgent&gt; approval &amp; MRN 12345</t:Subject>
  <t:InternetMessageId>&lt;abc@elitehospital.org&gt;</t:InternetMessageId>
  <t:ConversationId Id="CONV1"/>
  <t:DateTimeReceived>2026-10-30T12:00:00+02:00</t:DateTimeReceived>
  <t:From><t:Mailbox><t:EmailAddress>dr@elitehospital.org</t:EmailAddress></t:Mailbox></t:From>
  <t:ToRecipients><t:Mailbox><t:EmailAddress>duty@elitehospital.org</t:EmailAddress></t:Mailbox></t:ToRecipients>
  <t:Body BodyType="HTML">&lt;p&gt;Patient Name : Ahmed&lt;/p&gt;</t:Body>
</t:Message>`;

describe('parseGetItemsResponse', () => {
  it('decodes entities in subject and internet message id', () => {
    const [msg] = parseGetItemsResponse(ENVELOPE(MESSAGE));

    expect(msg.subject).toBe('Re: <urgent> approval & MRN 12345');
    expect(msg.messageId).toBe('<abc@elitehospital.org>');
  });

  it('reads the sender from From only, never from ToRecipients', () => {
    const [msg] = parseGetItemsResponse(ENVELOPE(MESSAGE));

    expect(msg.sender).toBe('dr@elitehospital.org');
  });

  it('returns an empty sender when the item has no From block', () => {
    const noFrom = MESSAGE
      .replace(/<t:From>[\s\S]*?<\/t:From>/, '')
      .replace('&lt;p&gt;Patient Name : Ahmed&lt;/p&gt;', '&lt;p&gt;x&lt;/p&gt;');

    const [msg] = parseGetItemsResponse(ENVELOPE(noFrom));

    // The old regex leaked the To recipient ("duty@...") into `sender`.
    expect(msg.sender).toBe('');
  });

  it('preserves the HTML body without double-decoding it', () => {
    const [msg] = parseGetItemsResponse(ENVELOPE(MESSAGE));

    expect(msg.htmlBody).toContain('<p>Patient Name : Ahmed</p>');
  });

  it('exposes ItemId and ChangeKey verbatim', () => {
    const [msg] = parseGetItemsResponse(ENVELOPE(MESSAGE));

    expect(msg.id).toBe('ITEM%5f1');
    expect(msg.changeKey).toBe('CK1');
  });

  it('normalizes DateTimeReceived to UTC ISO', () => {
    const [msg] = parseGetItemsResponse(ENVELOPE(MESSAGE));

    expect(msg.receivedAt).toBe('2026-10-30T10:00:00.000Z');
  });

  it('skips ResponseElementError entries instead of emitting junk messages', () => {
    const xml = `<?xml version="1.0"?><soap:Envelope xmlns:soap="s"><soap:Body>` +
      `<m:GetItemResponse xmlns:m="m"><m:ResponseMessages>` +
      `<m:GetItemResponseMessage ResponseClass="Success"><m:Items>${MESSAGE}</m:Items></m:GetItemResponseMessage>` +
      `<m:GetItemResponseMessage ResponseClass="Error">` +
        `<m:ResponseCode>ErrorItemNotFound</m:ResponseCode>` +
        `<m:DescriptiveLinkKey>0</m:DescriptiveLinkKey>` +
      `</m:GetItemResponseMessage>` +
      `</m:ResponseMessages></m:GetItemResponse></soap:Body></soap:Envelope>`;

    const parsed = parseGetItemsResponse(xml);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('ITEM%5f1');
  });

  it('parses multiple messages in one batch response', () => {
    const two = MESSAGE.replace('ITEM%5f1', 'ITEM%5f2').replace('CK1', 'CK2');
    const parsed = parseGetItemsResponse(ENVELOPE(MESSAGE + two));

    expect(parsed.map((m) => m.id)).toEqual(['ITEM%5f1', 'ITEM%5f2']);
  });

  it('returns an empty array for a response with no items', () => {
    expect(parseGetItemsResponse(ENVELOPE(''))).toEqual([]);
  });
});
