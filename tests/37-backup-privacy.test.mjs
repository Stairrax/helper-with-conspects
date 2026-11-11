// End-to-end backup privacy reminder: photo sources survive but never export silently.
export default async ({ open, ok }) => {
  const { page } = await open();
  const payload = await page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    const sample = 'TEST_IMAGE_DATA_FOR_RESTORE';
    await storage.idbSet('sources:backup-privacy-test', [{
      id: 'image', name: 'Личная тетрадь', kind: 'images',
      images: [{ mime: 'image/jpeg', data: sample, page: 1 }],
    }]);
    let notices = [], exportContent = null;
    const realConfirm = window.confirm, realCanShare = navigator.canShare, realShare = navigator.share;
    window.confirm = message => { notices.push(message); return false; };
    navigator.canShare = () => true;
    navigator.share = async ({ files }) => { exportContent = await files[0].text(); };
    try {
      document.getElementById('backupBtn').click();
      await new Promise(resolve => setTimeout(resolve, 500));
      const first = { count: notices.length, shared: exportContent !== null };
      window.confirm = message => { notices.push(message); return true; };
      document.getElementById('backupBtn').click();
      for (let i = 0; i < 40 && exportContent === null; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const exported = exportContent && JSON.parse(exportContent);
      return {
        first, messages: notices, exported: Boolean(exported),
        rawImages: exported?.idb['sources:backup-privacy-test']?.[0]?.images || [],
        apiKey: exported?.localStorage?.['kd.settings'],
      };
    } finally {
      window.confirm = realConfirm;
      if (realCanShare) navigator.canShare = realCanShare; else delete navigator.canShare;
      if (realShare) navigator.share = realShare; else delete navigator.share;
    }
  });
  ok(payload.first.count === 1 && !payload.first.shared,
    'photo-containing backup asks before creating or sharing a private copy');
  ok(payload.messages.every(s => s.includes('исходные фотографии') && s.includes('личные учебные материалы')),
    'warning explicitly mentions raw photos and private study materials');
  ok(payload.exported && payload.rawImages[0]?.data === 'TEST_IMAGE_DATA_FOR_RESTORE',
    'confirmed backup preserves original photos for OCR and restores');
  const noImages = await page.evaluate(async () => {
    const storage = await import('./js/storage.js');
    return (await storage.makeBackup()).idb['sources:backup-privacy-test'][0].images[0].data;
  });
  ok(noImages === 'TEST_IMAGE_DATA_FOR_RESTORE', 'export does not remove source images from saved projects');
};
