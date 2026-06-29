const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

exports.main = async (event) => {
  const shareCode = String((event && event.shareCode) || '').trim();
  if (!shareCode) {
    return {
      ok: false,
      message: '缺少分享码'
    };
  }
  try {
    const result = await cloud.openapi.wxacode.getUnlimited({
      scene: `shareCode=${shareCode}`,
      page: 'pages/room/room',
      checkPath: false,
      envVersion: 'trial'
    });
    return {
      ok: true,
      buffer: result.buffer.toString('base64')
    };
  } catch (error) {
    const errMsg = String((error && (error.errMsg || error.message)) || '');
    const errCode = error && (error.errCode || error.code);
    console.error('tableCode getUnlimited failed', {
      shareCode,
      errCode,
      errMsg
    });
    if (errMsg.includes('-604101') || errMsg.includes('no permission')) {
      return {
        ok: false,
        message: 'tableCode 云函数缺少生成二维码权限，请重新上传部署'
      };
    }
    return {
      ok: false,
      message: errCode ? `二维码生成失败：${errCode}` : '二维码生成失败，请稍后重试',
      detail: errMsg
    };
  }
};
