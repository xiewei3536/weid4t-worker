/**
 * 極簡 KV 模擬（測試 / 本機預覽用），支援本專案用到的 API：
 * get(key,{type}) / getWithMetadata / put(key,value,{metadata,expirationTtl}) / delete / list({prefix,limit})
 */
export class MockKV {
  constructor(seed) {
    this.map = new Map();
    this.meta = new Map();
    this.exp = new Map();
    this.writes = 0;
    this.reads = 0;
    if (seed) for (const [k, v] of Object.entries(seed)) this.map.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  _alive(key) {
    const e = this.exp.get(key);
    if (e && e <= Date.now()) {
      this.map.delete(key);
      this.exp.delete(key);
      return false;
    }
    return this.map.has(key);
  }
  async get(key, opts) {
    this.reads++;
    if (!this._alive(key)) return null;
    const v = this.map.get(key);
    const type = typeof opts === "string" ? opts : (opts && opts.type) || "text";
    if (type === "json") return typeof v === "string" ? JSON.parse(v) : v;
    if (type === "arrayBuffer") return typeof v === "string" ? new TextEncoder().encode(v).buffer : v;
    return typeof v === "string" ? v : String(v);
  }
  async getWithMetadata(key, opts) {
    const value = await this.get(key, opts);
    return { value, metadata: this.meta.get(key) || null };
  }
  async put(key, value, opts) {
    this.writes++;
    this.map.set(key, value);
    if (opts && opts.metadata) this.meta.set(key, opts.metadata);
    if (opts && opts.expirationTtl) this.exp.set(key, Date.now() + opts.expirationTtl * 1000);
    else this.exp.delete(key);
  }
  async delete(key) {
    this.map.delete(key);
    this.meta.delete(key);
    this.exp.delete(key);
  }
  async list(o) {
    const prefix = (o && o.prefix) || "";
    const limit = (o && o.limit) || 1000;
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix) && this._alive(k)).slice(0, limit).map((name) => ({ name }));
    return { keys, list_complete: true, cursor: "" };
  }
}
