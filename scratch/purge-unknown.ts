import fs from 'fs';
import { db } from '../src/firebase';
import { doc, deleteDoc } from 'firebase/firestore';

async function purgeUnknown() {
  const filePath = 'data/inpatient_approvals.json';
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const filtered = data.filter((r: any) => r.id !== 'mrn_0000000000' && r.mrn !== '0000000000' && !r.patientName?.includes('Unknown'));
    fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), 'utf8');
    console.log('Filtered local json from', data.length, 'to', filtered.length);
  }

  try {
    await deleteDoc(doc(db, 'inpatient_approvals', 'mrn_0000000000'));
    console.log('Successfully deleted mrn_0000000000 from Firestore inpatient_approvals');
  } catch (e) {
    console.error('Firestore delete error:', e);
  }
}

purgeUnknown().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
