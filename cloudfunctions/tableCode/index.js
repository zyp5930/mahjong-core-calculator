const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const shareCode = event.shareCode;
  if (!OPENID || typeof shareCode !== 'string' || !/^[A-Z0-9]{6,20}$/.test(shareCode)) return { ok: false, message: '无效邀请' };
  try {
    const { data } = await db.collection('tables').where({ shareCode }).limit(1).get();
    const table = data[0];
    if (!table || table.status !== 'active' || !(table.participantOpenids || []).includes(OPENID)) return { ok: false, message: '仅牌局成员可生成有效邀请' };
    const envVersion = process.env.MINIPROGRAM_ENV_VERSION || 'release';
    if (!['release', 'trial', 'develop'].includes(envVersion)) throw new Error('Invalid environment');
    const id = crypto.createHash('sha256').update(`code:${OPENID}`).digest('hex');
    await db.runTransaction(async (tx) => {
      const ref = tx.collection('request_limits').doc(id);
      let old;
      try { old = (await ref.get()).data; } catch (error) {
        if (/collection/i.test(error.message || '') || !/document.*(not.*exist|not.*found)|DOCUMENT_NOT_EXIST/i.test(error.message || '')) throw error;
      }
      const now = Date.now();
      if (old && now - old.startedAt < 10000) throw new Error('频率限制');
      await ref.set({ data: { startedAt: now, expiresAt: new Date(now + 86400000) } });
    });
    const result = await cloud.openapi.wxacode.getUnlimited({ scene: `shareCode=${shareCode}`, page: 'pages/join/join', checkPath: true, envVersion });
    return { ok: true, buffer: result.buffer.toString('base64') };
  } catch (error) {
    console.error('[tableCode failed]', { code: String(error.errCode || error.code || 'INTERNAL') });
    return { ok: false, message: '邀请二维码暂不可用，请稍后重试或使用微信卡片分享' };
  }
};
