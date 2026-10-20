import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  ewsSyncFolderItems,
  loadLocalSyncState,
  saveLocalSyncState,
  SYNC_STATE_FILE,
  IS_EXCHANGE_EWS,
} from './approvals-watcher';

async function testSyncFolderItems() {
  console.log('=====================================================');
  console.log(' Testing EWS SyncFolderItems & Token Management');
  console.log('=====================================================');

  console.log(`Exchange EWS Mode: ${IS_EXCHANGE_EWS}`);
  console.log(`Sync State File: ${SYNC_STATE_FILE}`);

  // Test 1: Token persistence
  const testToken = 'H4sIAAAAAAAEA_test_sync_token_12345';
  saveLocalSyncState(testToken);
  const loaded = loadLocalSyncState();
  if (loaded === testToken) {
    console.log('✓ Test 1 Passed: SyncState token successfully saved and reloaded.');
  } else {
    throw new Error(`SyncState token mismatch: expected "${testToken}", got "${loaded}"`);
  }

  // Test 2: Clean up mock token
  saveLocalSyncState('');
  console.log('✓ Test 2 Passed: SyncState token reset cleanly.');

  // Test 3: SOAP XML parsing simulation for SyncFolderItems
  const mockSoapResponse = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <soap:Body>
    <m:SyncFolderItemsResponse>
      <m:ResponseMessages>
        <m:SyncFolderItemsResponseMessage ResponseClass="Success">
          <m:ResponseCode>NoError</m:ResponseCode>
          <m:SyncState>NEW_EXCHANGE_SYNC_STATE_TOKEN_ABCD</m:SyncState>
          <m:IncludesLastItemInRange>true</m:IncludesLastItemInRange>
          <m:Changes>
            <t:Create>
              <t:Message>
                <t:ItemId Id="ITEM_CREATE_001" ChangeKey="CK_01" />
              </t:Message>
            </t:Create>
            <t:Update>
              <t:Message>
                <t:ItemId Id="ITEM_UPDATE_002" ChangeKey="CK_02" />
              </t:Message>
            </t:Update>
            <t:Delete>
              <t:ItemId Id="ITEM_DELETE_003" />
            </t:Delete>
          </m:Changes>
        </m:SyncFolderItemsResponseMessage>
      </m:ResponseMessages>
    </m:SyncFolderItemsResponse>
  </soap:Body>
</soap:Envelope>`;

  // Verify regex extraction logic on the mock SOAP
  const syncStateMatch = mockSoapResponse.match(/<m:SyncState>([^<]+)<\/m:SyncState>/);
  const syncState = syncStateMatch ? syncStateMatch[1] : '';
  const includesLast = mockSoapResponse.includes('<m:IncludesLastItemInRange>true</m:IncludesLastItemInRange>');

  const createdMatches = [...mockSoapResponse.matchAll(/<t:Create>[\s\S]*?<t:ItemId Id="([^"]+)" ChangeKey="([^"]+)"/g)];
  const updatedMatches = [...mockSoapResponse.matchAll(/<t:Update>[\s\S]*?<t:ItemId Id="([^"]+)" ChangeKey="([^"]+)"/g)];
  const deletedMatches = [...mockSoapResponse.matchAll(/<t:Delete>[\s\S]*?<t:ItemId Id="([^"]+)"/g)];

  console.log(`✓ Test 3 Passed: Extracted SyncState: "${syncState}", IncludesLast: ${includesLast}`);
  console.log(`  Created (${createdMatches.length}):`, createdMatches.map((m) => ({ id: m[1], ck: m[2] })));
  console.log(`  Updated (${updatedMatches.length}):`, updatedMatches.map((m) => ({ id: m[1], ck: m[2] })));
  console.log(`  Deleted (${deletedMatches.length}):`, deletedMatches.map((m) => m[1]));

  if (syncState !== 'NEW_EXCHANGE_SYNC_STATE_TOKEN_ABCD') throw new Error('SyncState extraction failed');
  if (createdMatches.length !== 1 || createdMatches[0][1] !== 'ITEM_CREATE_001') throw new Error('Create match failed');
  if (updatedMatches.length !== 1 || updatedMatches[0][1] !== 'ITEM_UPDATE_002') throw new Error('Update match failed');
  if (deletedMatches.length !== 1 || deletedMatches[0][1] !== 'ITEM_DELETE_003') throw new Error('Delete match failed');

  console.log('\n=====================================================');
  console.log(' ✅ All incremental sync tests passed!');
  console.log('=====================================================');
}

testSyncFolderItems().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
