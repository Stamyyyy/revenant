// Tag storage, keyed by fileId ("recordNum:seq" — see mft.js's fileId()),
// not by path or bare recordNum. Path changes on rename; recordNum alone
// gets reused by NTFS for a totally unrelated file once the original is
// deleted. fileId is the one identity that's actually stable for as long
// as the specific file exists, and unambiguous even after it doesn't.

const fs = require('fs');
const { atomicWriteFileSync } = require('./atomic-write');

function createTagStore(storePath) {
  function load() {
    try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch (e) { return {}; }
  }
  let byFileId = load(); // { [fileId]: string[] }
  function save() { atomicWriteFileSync(storePath, JSON.stringify(byFileId)); }

  function getTags(fileId) {
    return byFileId[fileId] || [];
  }

  function addTag(fileId, tag) {
    tag = tag.trim();
    if (!tag) return getTags(fileId);
    const current = byFileId[fileId] || [];
    if (!current.includes(tag)) {
      byFileId[fileId] = [...current, tag];
      save();
    }
    return byFileId[fileId];
  }

  function removeTag(fileId, tag) {
    const current = byFileId[fileId] || [];
    const next = current.filter((t) => t !== tag);
    if (next.length) byFileId[fileId] = next;
    else delete byFileId[fileId];
    save();
    return next;
  }

  // Every distinct tag currently in use, for e.g. an autocomplete list.
  function allTags() {
    const set = new Set();
    for (const tags of Object.values(byFileId)) for (const t of tags) set.add(t);
    return Array.from(set).sort();
  }

  function fileIdsForTag(tag) {
    return Object.keys(byFileId).filter((id) => byFileId[id].includes(tag));
  }

  // Called with fileIds confirmed stale by the caller (mft.resultsForFileIds
  // already does this check) — drops tags that point at an MFT slot since
  // reused by an unrelated file, rather than leaving them to accumulate
  // forever or, worse, ambiguously resurface later.
  function dropStale(staleFileIds) {
    let changed = false;
    for (const id of staleFileIds) {
      if (byFileId[id]) { delete byFileId[id]; changed = true; }
    }
    if (changed) save();
  }

  return { getTags, addTag, removeTag, allTags, fileIdsForTag, dropStale };
}

module.exports = { createTagStore };
