const crypto = require('crypto');

module.exports = function safety(cloud, db) {
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const jobId = (openid) => hash(`delete:${openid}`);

  async function readOptional(ref) {
    try { return (await ref.get()).data || null; } catch (error) {
      // Missing documents are optional; configuration and permission errors are not.
      if (/collection/i.test(error.message || '')) throw error;
      if (/document.*(not.*exist|not.*found)|DOCUMENT_NOT_EXIST/i.test(error.message || '')) return null;
      throw error;
    }
  }

  async function checkText(value, maxLength, openid) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
      throw new Error(`请输入1至${maxLength}字的内容`);
    }
    let result;
    try {
      result = await cloud.openapi.security.msgSecCheck({ openid, scene: 1, version: 2, content: value.trim() });
    } catch (error) {
      throw new Error('内容安全检查暂不可用，请稍后重试');
    }
    if (!result || Number(result.errCode || result.errcode || 0) !== 0 || !result.result) {
      throw new Error('内容安全检查暂不可用，请稍后重试');
    }
    if (result.result.suggest !== 'pass') throw new Error('内容未通过安全检查，请修改后重试');
    return value.trim();
  }

  function rejectAvatar(value, openid) {
    if (!value) return;
    if (typeof value !== 'string' || !value.startsWith('cloud://') || !value.includes(`/avatars/${openid}/`)) {
      throw new Error('头像来源无效，请重新选择微信头像');
    }
  }

  async function rateLimit(openid, action) {
    const bucket = ['getTableByShareCode', 'joinTable', 'createTable', 'updateMyProfile'].includes(action) ? action : 'general';
    const limit = bucket === 'createTable' ? 5 : bucket === 'general' ? 120 : 20;
    const id = hash(`${openid}:${bucket}`);
    await db.runTransaction(async (tx) => {
      const ref = tx.collection('request_limits').doc(id);
      const old = await readOptional(ref);
      const now = Date.now();
      const count = old && now - old.startedAt < 60000 ? old.count + 1 : 1;
      if (count > limit) throw new Error('操作过于频繁，请稍后重试');
      await ref.set({ data: { count, startedAt: count === 1 ? now : old.startedAt, expiresAt: new Date(now + 86400000) } });
    });
  }

  function publicData(value) {
    const caller = cloud.getWXContext().OPENID;
    if (Array.isArray(value)) return value.map(publicData);
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (['participantOpenids', 'avatarFileId', '_openid', 'readBy'].includes(key)) continue;
      if (['openid', 'ownerOpenid', 'operatorOpenid', 'targetOpenid'].includes(key)) {
        // Keep the existing client identity comparisons without disclosing other openids.
        result[key] = item === caller ? item : item ? 'member' : '';
      } else if (key === 'notifications') {
        result[key] = publicData((item || []).filter((n) => !n.targetOpenid || n.targetOpenid === caller));
      } else {
        result[key] = publicData(item);
      }
    }
    // Legacy unreviewed names are not redistributed. They can be edited and checked again.
    if (Array.isArray(value.players) && value.contentChecked !== true) result.name = '积分牌局';
    if (Array.isArray(value.players) && value.contentChecked !== true) {
      const legacyNames = (item) => {
        if (Array.isArray(item)) return item.map(legacyNames);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.entries(item).map(([key, val]) => [key,
          ['name', 'fromPlayerName', 'toPlayerName'].includes(key) ? (val === '已删除成员' ? val : '成员') : legacyNames(val)]));
      };
      const safe = legacyNames(result);
      safe.name = '积分牌局';
      safe.notifications = [];
      return safe;
    }
    return result;
  }

  async function getDeletionStatus(openid) {
    const job = await readOptional(db.collection('privacy_jobs').doc(jobId(openid)));
    return { pending: !!job, phase: job && job.phase || '' };
  }

  async function assertNotDeleting(openid, tx) {
    const job = await readOptional(tx.collection('privacy_jobs').doc(jobId(openid)));
    if (job) throw new Error('个人数据正在删除，请稍后重试');
  }

  // Bounded, resumable deletion: collect identifiers first, then scrub all copies
  // (including group summaries in rounds the user did not participate in).
  async function deleteBatch(openid) {
    const ref = db.collection('privacy_jobs').doc(jobId(openid));
    await db.runTransaction(async (tx) => {
      const target = tx.collection('privacy_jobs').doc(jobId(openid));
      if (!await readOptional(target)) await target.set({ data: { phase: 'collect', cursor: '', ids: [], files: [], processed: 0 } });
    });
    const job = await readOptional(ref);
    if (job.phase === 'legacy') {
      const filter = { ownerOpenid: openid };
      if (job.cursor) filter._id = db.command.gt(job.cursor);
      const { data } = await db.collection('legacy_avatar_files').where(filter).orderBy('_id', 'asc').limit(50).get();
      const files = [...new Set([...job.files, ...data.map((item) => item.fileID)])];
      await ref.update({ data: { files, cursor: data.length ? data[data.length - 1]._id : '', phase: data.length < 50 ? 'files' : 'legacy' } });
      return { done: false, phase: 'legacy', processed: job.processed };
    }
    if (job.phase === 'files') {
      const batch = job.files.slice(0, 50);
      if (batch.length) {
        const result = await cloud.deleteFile({ fileList: batch });
        const succeeded = (result.fileList || []).filter((f) => f.status === 0).map((f) => f.fileID);
        const remaining = job.files.filter((file) => !succeeded.includes(file));
        await ref.update({ data: { files: remaining } });
        if (remaining.length === job.files.length) throw new Error('历史头像清理失败，请稍后继续删除或联系开发者');
        return { done: false, phase: 'files', processed: job.processed };
      }
      const legacy = await db.collection('legacy_avatar_files').where({ ownerOpenid: openid }).limit(50).get();
      if (legacy.data.length) {
        for (const item of legacy.data) await db.collection('legacy_avatar_files').doc(item._id).remove();
        return { done: false, phase: 'files', processed: job.processed };
      }
      await db.collection('request_limits').doc(hash(`code:${openid}`)).remove();
      for (const bucket of ['general' , 'getTableByShareCode', 'joinTable', 'createTable', 'updateMyProfile']) {
        await db.collection('request_limits').doc(hash(`${openid}:${bucket}`)).remove();
      }
      await ref.remove();
      return { done: true, processed: job.processed };
    }
    const filter = job.cursor ? { _id: db.command.gt(job.cursor) } : {};
    const { data: tables } = await db.collection('tables').where(filter).orderBy('_id', 'asc').limit(20).get();
    for (const snapshot of tables) {
      if (job.phase === 'collect') {
        for (const player of snapshot.players || []) {
          if (player.openid !== openid) continue;
          job.ids.push(player.id, player.groupPlayerId || player.id);
          const file = player.avatarFileId || player.avatarUrl || '';
          // Legacy uploads used this user-owned path. Do not delete arbitrary supplied IDs.
          if (file.startsWith('cloud://') && file.includes(`/avatars/${openid}/`)) job.files.push(file);
        }
      } else {
        await db.runTransaction(async (tx) => {
          const tableRef = tx.collection('tables').doc(snapshot._id);
          const table = await readOptional(tableRef);
          if (!table) return;
          const ids = new Set(job.ids);
          const related = (p) => p.openid === openid || ids.has(p.id) || ids.has(p.groupPlayerId);
          const scrub = (value) => {
            if (Array.isArray(value)) return value.map(scrub);
            if (!value || typeof value !== 'object') return value;
            const out = { ...value };
            if (related(value) || ids.has(value.playerId)) {
              if ('name' in out) out.name = '已删除成员';
              if ('openid' in out) { out.openid = ''; out.deleted = true; out.isOwner = false; }
              if ('avatarFileId' in out) out.avatarFileId = '';
              if ('avatarUrl' in out) out.avatarUrl = '';
            }
            if (ids.has(value.fromPlayerId)) out.fromPlayerName = '已删除成员';
            if (ids.has(value.toPlayerId)) out.toPlayerName = '已删除成员';
            if (value.operatorOpenid === openid) out.operatorOpenid = '';
            for (const key of Object.keys(out)) {
              if (out[key] && typeof out[key] === 'object') out[key] = scrub(out[key]);
            }
            return out;
          };
          const cleaned = scrub(table);
          cleaned.participantOpenids = (table.participantOpenids || []).filter((id) => id !== openid);
          cleaned.notifications = (table.notifications || []).filter((n) => n.targetOpenid !== openid && !ids.has(n.fromPlayerId) && !ids.has(n.toPlayerId)).map((n) => ({ ...n, readBy: (n.readBy || []).filter((id) => id !== openid) }));
          if (table.ownerOpenid === openid) {
            const successor = (cleaned.players || []).find((p) => p.openid && !p.deleted);
            if (!successor) { await tableRef.remove(); return; }
            cleaned.ownerOpenid = successor.openid;
            successor.isOwner = true;
            cleaned.name = '积分牌局';
            cleaned.shareCode = crypto.randomBytes(10).toString('hex').toUpperCase();
          }
          if (cleaned._openid === openid) cleaned._openid = '';
          if (JSON.stringify(cleaned) !== JSON.stringify(table)) {
            delete cleaned._id;
            cleaned.revision = (Number(table.revision) || 0) + 1;
            cleaned.updatedAt = Date.now();
            await tableRef.set({ data: cleaned });
          }
        });
      }
    }
    const next = {
      ...job,
      ids: [...new Set(job.ids)], files: [...new Set(job.files)],
      cursor: tables.length ? tables[tables.length - 1]._id : job.cursor,
      processed: job.processed + tables.length
    };
    delete next._id;
    if (tables.length < 20) { next.phase = job.phase === 'collect' ? 'scrub' : 'legacy'; next.cursor = ''; }
    await ref.set({ data: next });
    return { done: false, phase: next.phase, processed: next.processed };
  }

  async function deleteMyData(openid) {
    const token = crypto.randomBytes(16).toString('hex');
    await db.runTransaction(async (tx) => {
      const ref = tx.collection('privacy_locks').doc(jobId(openid));
      const lock = await readOptional(ref);
      if (lock && lock.until > Date.now()) throw new Error('删除仍在处理中，请稍后继续');
      // Must exceed deployed function timeout (60 seconds).
      await ref.set({ data: { token, until: Date.now() + 120000 } });
    });
    try { return await deleteBatch(openid); }
    finally {
      await db.runTransaction(async (tx) => {
        const ref = tx.collection('privacy_locks').doc(jobId(openid));
        const lock = await readOptional(ref);
        if (lock && lock.token === token) await ref.remove();
      });
    }
  }

  return { checkText, rejectAvatar, rateLimit, publicData, deleteMyData, getDeletionStatus, assertNotDeleting };
};
