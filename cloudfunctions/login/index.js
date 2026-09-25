const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('请从小程序内访问');
  return {
    openid: OPENID
  };
};
