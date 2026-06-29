const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

exports.main = async (event) => {
  const shareCode = String((event && event.shareCode) || '').trim();
  if (!shareCode) {
    throw new Error('缺少分享码');
  }
  const result = await cloud.openapi.wxacode.getUnlimited({
    scene: `shareCode=${shareCode}`,
    page: 'pages/room/room',
    checkPath: false,
    envVersion: 'trial'
  });
  return {
    buffer: result.buffer.toString('base64')
  };
};
