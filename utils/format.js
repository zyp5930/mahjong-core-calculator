function pad(num) {
  return num < 10 ? `0${num}` : `${num}`;
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  return `${month}-${day} ${hour}:${minute}`;
}

function formatDuration(startAt, endAt) {
  if (!startAt) return '';
  const diff = Math.max(0, (endAt || Date.now()) - startAt);
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest}分钟`;
  return `${hours}小时${rest}分`;
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeShareCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function normalizeScore(value) {
  const number = Number(value) || 0;
  return Number(number.toFixed(10));
}

module.exports = {
  formatTime,
  formatDuration,
  normalizeScore,
  makeId,
  makeShareCode
};
