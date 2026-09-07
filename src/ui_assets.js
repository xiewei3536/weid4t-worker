/**
 * 管理頁的 CSS 與前端 JS（純字串，由 ui.js 內嵌到 HTML）。
 * 注意：這兩段字串裡不要出現反引號與 ${，避免破壞外層模板。
 */

export const ADMIN_CSS = `
:root{
  color-scheme:dark;
  --bg-0:#060810;--bg-1:#0B1018;--surface:#121826;--surface-2:#0E1420;--surface-3:#182031;
  --border:#232C3D;--border-hi:#2F3B52;
  --accent:#2DD4BF;--accent-deep:#0EA5A0;--accent-soft:rgba(45,212,191,.12);
  --gold:#FBBF24;--danger:#FF5C6C;--ok:#34D399;--info:#60A5FA;
  --text:#EEF2F7;--text-dim:#98A3B6;--text-faint:#5D6880;
  --radius:16px;--radius-sm:11px;
  --shadow:0 14px 40px -22px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.025);
  --font:-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,"Segoe UI",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;min-height:100vh;color:var(--text);font-family:var(--font);line-height:1.55;
  background:
    radial-gradient(1100px 520px at 15% -10%,rgba(45,212,191,.10),transparent 60%),
    radial-gradient(900px 480px at 100% 0%,rgba(251,191,36,.06),transparent 55%),
    linear-gradient(170deg,var(--bg-1),var(--bg-0) 70%);
  background-attachment:fixed;
  -webkit-font-smoothing:antialiased;padding-bottom:70px;
}
a{color:var(--accent)}
.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
.mono{font-family:var(--mono)}
.num{font-variant-numeric:tabular-nums}

/* ── 頂欄 ── */
.topbar{
  position:sticky;top:0;z-index:40;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  background:rgba(8,11,18,.78);border-bottom:1px solid rgba(255,255,255,.05);
}
.topbar .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;height:60px}
.brand{display:flex;align-items:center;gap:11px;min-width:0}
.brand .logo{
  width:34px;height:34px;border-radius:11px;flex:none;
  background:linear-gradient(135deg,var(--accent),var(--accent-deep));
  box-shadow:0 0 0 4px rgba(45,212,191,.12),0 8px 20px -8px rgba(45,212,191,.7);
  display:flex;align-items:center;justify-content:center;color:#052A26;font-weight:900;font-size:17px;
}
.brand h1{font-size:17px;font-weight:800;margin:0;letter-spacing:.3px;white-space:nowrap}
.brand .tag{font-size:11px;color:var(--text-dim);margin-left:6px;font-weight:500}
.top-right{display:flex;align-items:center;gap:8px;flex:none}
.pill{font-size:12px;color:var(--text-dim);border:1px solid var(--border);border-radius:999px;padding:5px 11px;white-space:nowrap;background:rgba(255,255,255,.02)}
.pill b{color:var(--text);font-weight:700}
.iconbtn{
  width:36px;height:36px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text-dim);
  cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;transition:all .15s;
}
.iconbtn:hover{color:var(--accent);border-color:var(--accent)}
.iconbtn.spin{animation:rot .8s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}

/* ── 分頁 ── */
.tabs-wrap{position:sticky;top:60px;z-index:30;background:linear-gradient(180deg,rgba(8,11,18,.92),rgba(8,11,18,.6) 70%,transparent);padding:12px 0 8px}
.tabs{display:flex;gap:6px;overflow-x:auto;padding:3px;scrollbar-width:none;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:14px}
.tabs::-webkit-scrollbar{display:none}
.tab{
  flex:1 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:7px;
  padding:10px 14px;font-size:14px;font-weight:700;font-family:inherit;color:var(--text-dim);
  background:transparent;border:0;border-radius:11px;cursor:pointer;white-space:nowrap;transition:all .15s;position:relative;
}
.tab:hover{color:var(--text)}
.tab.active{color:#04201E;background:linear-gradient(135deg,var(--accent),var(--accent-deep));box-shadow:0 8px 18px -10px rgba(45,212,191,.8)}
.tab .cnt{font-size:11px;font-weight:800;padding:1px 7px;border-radius:999px;background:rgba(255,255,255,.08);color:inherit}
.tab.active .cnt{background:rgba(0,0,0,.18)}
.tab .tdot{position:absolute;top:6px;right:8px;width:7px;height:7px;border-radius:50%;background:var(--gold);box-shadow:0 0 8px var(--gold)}

.panel{display:none}
.panel.active{display:block;animation:fade .22s ease}
@keyframes fade{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}

/* ── 區塊卡 ── */
.block{background:linear-gradient(180deg,var(--surface),var(--surface-2) 140%);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-top:14px;box-shadow:var(--shadow)}
.block-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.block-title{font-size:15px;font-weight:800;color:var(--text);display:flex;align-items:center;gap:8px}
.block-title .ic{font-size:16px}
.block-sub{font-size:12.5px;color:var(--text-dim);margin:-6px 0 12px;line-height:1.6}
.count-pill{font-size:12px;color:var(--text-dim);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:4px 10px;white-space:nowrap}
.grid2{display:grid;grid-template-columns:1fr;gap:14px}
@media(min-width:760px){.grid2{grid-template-columns:1fr 1fr}.grid2>.block{margin-top:0}.grid2{margin-top:14px}}

/* ── 概覽 ── */
.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
@media(min-width:640px){.stat-grid{grid-template-columns:repeat(6,1fr)}}
.stat-box{background:var(--surface-2);border:1px solid var(--border);border-radius:13px;padding:13px 8px;text-align:center;transition:border-color .15s}
.stat-box:hover{border-color:var(--border-hi)}
.sb-num{font-size:27px;font-weight:800;line-height:1.05;font-variant-numeric:tabular-nums}
.sb-num.accent{color:var(--accent)}.sb-num.ok{color:var(--ok)}.sb-num.warn{color:var(--gold)}.sb-num.mute{color:var(--text-dim)}
.sb-label{font-size:11.5px;color:var(--text-dim);margin-top:5px}
.banner{margin-top:12px;padding:12px 14px;border-radius:12px;font-size:13.5px;line-height:1.65;border:1px solid var(--border);display:flex;gap:10px;align-items:flex-start}
.banner .bi{font-size:18px;line-height:1.3;flex:none}
.banner b{font-weight:700}
.banner.on{color:var(--accent);background:var(--accent-soft);border-color:rgba(45,212,191,.32)}
.banner.off{color:var(--text-dim);background:var(--surface-2)}
.banner.warn{color:var(--gold);background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.3)}
.banner.info{color:var(--info);background:rgba(96,165,250,.08);border-color:rgba(96,165,250,.3)}
.kv{display:grid;grid-template-columns:1fr;gap:8px}
@media(min-width:560px){.kv{grid-template-columns:1fr 1fr}}
.kv .item{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:11px 13px;min-width:0}
.kv .item.full{grid-column:1/-1}
.kv .k{font-size:11.5px;color:var(--text-dim);letter-spacing:.3px;margin-bottom:3px}
.kv .v{font-size:15px;font-weight:700;color:var(--text);word-break:break-all}
.kv .v.mono{font-size:12.5px;font-weight:500;color:var(--accent)}
.badge{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap;border:1px solid transparent}
.badge.on{color:var(--gold);background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.35)}
.badge.off{color:var(--text-dim);background:rgba(151,162,180,.10);border-color:var(--border)}
.ok-b{color:var(--accent);background:var(--accent-soft);border-color:rgba(45,212,191,.35)}
.good-b{color:var(--ok);background:rgba(52,211,153,.12);border-color:rgba(52,211,153,.35)}
.warn-b{color:var(--gold);background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.35)}
.mute-b{color:var(--text-dim);background:rgba(151,162,180,.10);border-color:var(--border)}
.danger-b{color:var(--danger);background:rgba(255,92,108,.12);border-color:rgba(255,92,108,.4)}
.info-b{color:var(--info);background:rgba(96,165,250,.12);border-color:rgba(96,165,250,.35)}
.now-list{display:flex;flex-direction:column;gap:7px}
.now-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:11px;background:var(--surface-2);border:1px solid var(--border);font-size:13.5px}
.now-row .nm{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 38%}
.now-row .ch{color:var(--accent);font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.now-row .tm{color:var(--text-faint);font-size:12px;flex:none}
.ver-bars{display:flex;flex-direction:column;gap:7px}
.ver-bar{display:grid;grid-template-columns:110px 1fr 40px;align-items:center;gap:10px;font-size:13px}
.ver-bar .vb{height:9px;border-radius:999px;background:var(--surface-3);overflow:hidden}
.ver-bar .vb i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent-deep),var(--accent))}
.ver-bar.old .vb i{background:linear-gradient(90deg,#B45309,var(--gold))}
.ver-bar .vn{color:var(--text-dim);text-align:right;font-variant-numeric:tabular-nums}
.quick{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
@media(min-width:640px){.quick{grid-template-columns:repeat(4,1fr)}}
.quick button{padding:12px 10px;font-size:13.5px;font-weight:700;font-family:inherit;color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:12px;cursor:pointer;transition:all .15s}
.quick button:hover{border-color:var(--accent);color:var(--accent)}

/* ── 表單 ── */
label{display:block;font-size:13.5px;color:var(--text);font-weight:600;margin:16px 0 7px}
label .hint{display:block;font-weight:400;font-size:12px;color:var(--text-dim);margin-top:2px;line-height:1.5}
input[type=text],input[type=number],input[type=url],textarea,select.sel{
  width:100%;padding:13px 14px;font-size:16px;border-radius:13px;border:1px solid var(--border);
  background:var(--surface-2);color:var(--text);font-family:inherit;transition:border-color .15s,box-shadow .15s;
}
textarea{min-height:78px;resize:vertical;line-height:1.5}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(45,212,191,.18)}
input::placeholder,textarea::placeholder{color:#55607A}
select.sel{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--text-dim) 50%),linear-gradient(135deg,var(--text-dim) 50%,transparent 50%);background-position:calc(100% - 20px) 50%,calc(100% - 14px) 50%;background-size:6px 6px;background-repeat:no-repeat}
.switch-row{display:flex;align-items:center;gap:13px;margin-top:12px;background:var(--surface-2);border:1px solid var(--border);border-radius:13px;padding:13px 15px;cursor:pointer}
.switch-row input[type=checkbox]{width:22px;height:22px;flex:none;accent-color:var(--accent);cursor:pointer;margin:0}
.switch-row label{margin:0;font-weight:600;font-size:14px;cursor:pointer;flex:1}
.switch-row .hint{display:block;font-weight:400;font-size:12px;color:var(--text-dim)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.row2 label{margin-top:12px}
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:15px;font-size:16px;font-weight:700;
  border:1px solid transparent;border-radius:13px;margin-top:14px;cursor:pointer;font-family:inherit;transition:transform .08s,filter .15s,background .15s,border-color .15s;
}
.btn:active{transform:translateY(1px)}
.btn[disabled]{opacity:.55;cursor:progress}
.btn-primary{background:linear-gradient(135deg,var(--accent),var(--accent-deep));color:#04201E;box-shadow:0 10px 24px -12px rgba(45,212,191,.7)}
.btn-primary:hover{filter:brightness(1.06)}
.btn-secondary{background:transparent;color:var(--text);border:1px solid var(--border)}
.btn-secondary:hover{border-color:var(--accent);color:var(--accent)}
.btn-danger{background:transparent;color:var(--danger);border:1px solid rgba(255,92,108,.4)}
.btn-danger:hover{background:rgba(255,92,108,.08)}
.btn-row{display:flex;gap:8px;flex-wrap:wrap}
.btn-row .btn{width:auto;flex:1 1 auto;margin-top:10px}
.btn-mini{
  padding:9px 13px;font-size:13.5px;font-weight:700;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);
  cursor:pointer;font-family:inherit;white-space:nowrap;transition:filter .15s,border-color .15s,background .15s;
}
.btn-mini:hover{border-color:var(--border-hi);filter:brightness(1.08)}
.btn-mini:active{transform:translateY(1px)}
.btn-mini[disabled]{opacity:.55}
.btn-mini.btn-ok{background:linear-gradient(135deg,var(--accent),var(--accent-deep));color:#04201E;border-color:transparent}
.btn-mini.btn-danger{color:var(--danger);border-color:rgba(255,92,108,.4);background:rgba(255,92,108,.07)}
.btn-mini.btn-gold{color:var(--gold);border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.08)}
.btn-mini.btn-info{color:var(--info);border-color:rgba(96,165,250,.4);background:rgba(96,165,250,.08)}
.mini-input{padding:9px 11px;font-size:15px;border-radius:9px;border:1px solid var(--border);background:var(--bg-1);color:var(--text);font-family:inherit;min-width:0}
.mini-input.grow{flex:1 1 auto}
.mini-days{width:66px;flex:0 0 66px}
.mini-select{padding:9px 9px;font-size:14px;border-radius:9px;border:1px solid var(--border);background:var(--bg-1);color:var(--text);font-family:inherit}
.row-form{display:flex;gap:8px;align-items:center;margin:0;flex-wrap:wrap}
.row-form.wide{width:100%}
.inline-note{font-size:12.5px;color:var(--text-dim);margin-top:8px;line-height:1.6}
.inline-note b{color:var(--gold)}
code{background:var(--surface-2);border:1px solid var(--border);padding:2px 7px;border-radius:7px;word-break:break-all;font-family:var(--mono);font-size:12.5px;color:var(--accent)}

/* ── 測試結果 ── */
#testResult{margin-top:14px;display:none}
.result-card{border-radius:14px;padding:15px;border:1px solid var(--border);background:var(--surface-2)}
.result-head{display:flex;align-items:center;gap:12px}
.result-icon{width:38px;height:38px;flex:none;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;background:rgba(151,162,180,.12);color:var(--text-dim)}
.result-card.ok{border-color:rgba(45,212,191,.4);background:rgba(45,212,191,.07)}
.result-card.ok .result-icon{background:rgba(45,212,191,.16);color:var(--accent)}
.result-card.bad{border-color:rgba(255,92,108,.4);background:rgba(255,92,108,.07)}
.result-card.bad .result-icon{background:rgba(255,92,108,.16);color:var(--danger)}
.result-title{font-size:15px;font-weight:700}
.result-sub{font-size:12.5px;color:var(--text-dim);margin-top:1px}
.result-stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:13px}
.stat{flex:1 1 90px;background:rgba(0,0,0,.25);border:1px solid var(--border);border-radius:10px;padding:9px 11px}
.stat .sk{font-size:11px;color:var(--text-dim)}
.stat .sv{font-size:16px;font-weight:700;color:var(--text);margin-top:2px;font-variant-numeric:tabular-nums}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.chip-s{font-size:12px;padding:4px 9px;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--text-dim)}
.chip-s b{color:var(--text)}
.note-box{margin-top:12px;padding:11px 13px;border-radius:10px;font-size:13px;line-height:1.7;border:1px solid var(--border)}
.note-box.ok{background:rgba(45,212,191,.10);border-color:rgba(45,212,191,.35);color:var(--accent)}
.note-box.bad{background:rgba(255,92,108,.08);border-color:rgba(255,92,108,.35);color:var(--danger)}
.note-box.warn{background:rgba(251,191,36,.10);border-color:rgba(251,191,36,.35);color:var(--gold)}
.note-box.mute{background:rgba(151,162,180,.08);border-color:var(--border);color:var(--text-dim)}

/* ── 搜尋 / 篩選 ── */
.search{width:100%;padding:12px 14px;font-size:16px;border-radius:12px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-family:inherit;margin-bottom:10px}
.filters{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:12px}
.fchip{padding:7px 13px;font-size:13px;font-weight:600;font-family:inherit;color:var(--text-dim);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;cursor:pointer;transition:all .12s}
.fchip:hover{color:var(--text)}
.fchip.active{color:var(--accent);background:var(--accent-soft);border-color:rgba(45,212,191,.4)}
.empty{color:var(--text-dim);font-size:14px;text-align:center;padding:26px 10px;border:1px dashed var(--border);border-radius:12px}
.bulk-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;margin-bottom:12px;background:var(--surface-2);border:1px solid var(--border);border-radius:12px}
.bulk-label{font-size:13px;font-weight:700;margin-right:auto;color:var(--text-dim)}

/* ── 裝置卡 ── */
.dev-list{display:grid;grid-template-columns:1fr;gap:11px}
@media(min-width:820px){.dev-list{grid-template-columns:1fr 1fr}}
.dev-card{background:var(--surface-2);border:1px solid var(--border);border-radius:15px;padding:14px 15px;transition:border-color .15s;min-width:0}
.dev-card:hover{border-color:var(--border-hi)}
.dev-card.hide,.code-row.hide{display:none}
.dev-card.is-blocked{border-color:rgba(255,92,108,.35)}
.dev-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.dev-title{min-width:0;display:flex;align-items:center;gap:10px}
.sdot{width:11px;height:11px;border-radius:50%;flex:none;position:relative}
.sdot.online{background:var(--ok);box-shadow:0 0 10px rgba(52,211,153,.8)}
.sdot.online::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid rgba(52,211,153,.4);animation:pulse 1.8s ease-out infinite}
@keyframes pulse{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.5);opacity:0}}
.sdot.today{background:var(--gold)}
.sdot.offline{background:#3C475C}
.dev-name{font-size:16px;font-weight:800;color:var(--text);word-break:break-all;line-height:1.3}
.dev-id{font-size:11.5px;color:var(--text-faint);margin-top:1px;word-break:break-all}
.dev-badges{display:flex;align-items:center;gap:6px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
.dev-now{margin-top:11px;padding:9px 12px;border-radius:10px;background:rgba(45,212,191,.07);border:1px solid rgba(45,212,191,.2);font-size:13.5px;display:flex;gap:8px;align-items:center}
.dev-now .lbl{color:var(--text-dim);font-size:12px;flex:none}
.dev-now .val{color:var(--accent);font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dev-now .ago{color:var(--text-faint);font-size:11.5px;margin-left:auto;flex:none}
.facts{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 14px;margin:12px 0 4px}
.fact{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;border-bottom:1px dashed #1E2636;padding-bottom:5px;min-width:0}
.fk{color:var(--text-dim);flex:0 0 auto}
.fv{font-weight:600;text-align:right;word-break:break-all;color:var(--text)}
.fv.ok{color:var(--accent)}.fv.bad{color:var(--danger)}.fv.mute{color:var(--text)}.fv.warn{color:var(--gold)}
.dev-curmsg{margin-top:10px;padding:9px 11px;border-radius:9px;font-size:13px;border:1px solid var(--border);word-break:break-word}
.dev-curmsg.lv-info{color:var(--accent);background:rgba(45,212,191,.08);border-color:rgba(45,212,191,.3)}
.dev-curmsg.lv-warn{color:var(--gold);background:rgba(251,191,36,.10);border-color:rgba(251,191,36,.35)}
.dev-cmd{margin-top:10px;padding:9px 11px;border-radius:9px;font-size:13px;border:1px solid rgba(96,165,250,.35);background:rgba(96,165,250,.08);color:var(--info);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dev-cmd form{margin-left:auto}
.dev-primary{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.dev-more{margin-top:10px}
.dev-more summary{cursor:pointer;font-size:13px;color:var(--text-dim);list-style:none;padding:7px 0;user-select:none}
.dev-more summary::-webkit-details-marker{display:none}
.dev-more[open] summary{color:var(--accent)}
.dev-more-body{display:flex;flex-direction:column;gap:9px;padding-top:6px}
.dev-more-body .sect{font-size:11.5px;color:var(--text-faint);letter-spacing:.6px;margin-top:4px;text-transform:uppercase}

/* ── 啟動碼 ── */
.gen-form{background:var(--surface-2);border:1px solid var(--border);border-radius:13px;padding:14px;margin-bottom:12px}
.gen-grid{display:flex;gap:10px}
.gen-field{flex:1}
.gen-field label{display:block;font-size:12.5px;color:var(--text-dim);font-weight:600;margin:0 0 6px}
.gen-field input,.gen-input{width:100%;padding:12px 13px;font-size:16px;border-radius:11px;border:1px solid var(--border);background:var(--bg-1);color:var(--text);font-family:inherit}
.gen-form .btn{margin-top:12px}
.code-list{display:flex;flex-direction:column;gap:8px;max-height:520px;overflow-y:auto;padding-right:2px}
.code-row{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:11px 13px}
.code-row-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.code-val{font-size:21px;font-weight:800;color:var(--accent);letter-spacing:2.5px;word-break:break-all;font-family:var(--mono);cursor:pointer}
.code-val:hover{text-decoration:underline dotted}
.code-row-meta{color:var(--text-dim);font-size:12.5px;margin-top:6px;word-break:break-all}
.code-row-actions{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap}

/* ── 通知 / QR ── */
.hint-line{font-size:12.5px;color:var(--gold);background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);border-radius:9px;padding:9px 11px;margin-top:10px}
.qr-preview{display:flex;justify-content:center;padding:12px;background:#fff;border-radius:12px;margin-bottom:6px}
.qr-preview img{max-width:200px;max-height:200px;width:auto;height:auto;display:block}
.file-input{width:100%;padding:11px;font-size:14px;border-radius:11px;border:1px dashed var(--border);background:var(--surface-2);color:var(--text-dim);font-family:inherit;margin-bottom:4px}
.preview-tv{margin-top:12px;border-radius:12px;background:#000;border:1px solid var(--border);padding:12px 12px 10px;position:relative;overflow:hidden}
.preview-tv .ptitle{font-size:11px;color:var(--text-faint);margin-bottom:8px;letter-spacing:.5px}
.preview-tv .pm{background:#0a0f18;color:var(--gold);font-size:14px;padding:7px 12px;white-space:nowrap;overflow:hidden}
.preview-tv .pm span{display:inline-block;padding-left:100%;animation:marq 12s linear infinite}
@keyframes marq{to{transform:translateX(-100%)}}
.preview-tv .pn{display:inline-block;margin:10px auto 0;padding:8px 18px;border-radius:20px;background:rgba(45,212,191,.16);border:1px solid rgba(45,212,191,.4);color:var(--accent);font-size:14px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.preview-tv .center{text-align:center}

.footnote{text-align:center;color:var(--text-faint);font-size:12.5px;margin-top:26px;line-height:1.8}
.footnote code{white-space:nowrap;display:inline-block;margin:2px 0}

/* ── toast ── */
#toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(20px);opacity:0;z-index:100;pointer-events:none;transition:all .22s ease;max-width:calc(100% - 32px)}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#toast .t{padding:13px 18px;border-radius:13px;font-size:14.5px;font-weight:600;color:var(--text);background:rgba(18,24,38,.96);border:1px solid var(--border);box-shadow:0 18px 40px -16px rgba(0,0,0,.9);display:flex;gap:10px;align-items:center;backdrop-filter:blur(10px)}
#toast .t.ok{border-color:rgba(45,212,191,.5)}#toast .t.ok .ti{color:var(--accent)}
#toast .t.bad{border-color:rgba(255,92,108,.5)}#toast .t.bad .ti{color:var(--danger)}
#toast .ti{font-weight:900;font-size:17px}

/* ── modal ── */
.modal-bg{position:fixed;inset:0;background:rgba(3,5,10,.72);z-index:90;display:none;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)}
.modal-bg.show{display:flex;animation:fade .2s ease}
.modal{width:100%;max-width:520px;background:linear-gradient(180deg,var(--surface),var(--surface-2));border:1px solid rgba(45,212,191,.4);border-radius:18px;padding:22px;box-shadow:0 30px 80px -30px rgba(0,0,0,1)}
.modal h3{margin:0 0 6px;font-size:18px}
.modal .meta{color:var(--text-dim);font-size:13px;margin-bottom:12px}
.code-box{max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:12px;background:var(--bg-1);padding:6px}
.cg-row{padding:10px 12px;border-bottom:1px solid #1b2231;font-size:20px;letter-spacing:2.5px;font-family:var(--mono);color:var(--accent);font-weight:700}
.cg-row:last-child{border-bottom:0}
.modal .btn{margin-top:12px}

.sr{position:absolute;left:-9999px;top:0}
@media(max-width:480px){.brand .tag{display:none}.top-right .clock{display:none}}
`;

export const ADMIN_JS = `
(function(){
  var $ = function(s, r){ return (r||document).querySelector(s); };
  var $$ = function(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };

  /* ── toast ── */
  var toastTimer = null;
  function toast(msg, ok){
    var box = $('#toast'); if(!box) return;
    box.innerHTML = '<div class="t ' + (ok===false?'bad':'ok') + '"><span class="ti">' + (ok===false?'✕':'✓') + '</span><span></span></div>';
    box.querySelector('span:last-child').textContent = msg;
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ box.classList.remove('show'); }, ok===false?5200:3200);
  }
  window.toast = toast;

  /* ── 分頁 ── */
  function showTab(name, el){
    $$('.panel').forEach(function(p){ p.classList.toggle('active', p.dataset.panel === name); });
    $$('.tab').forEach(function(t){ t.classList.toggle('active', t.dataset.tab === name); });
    try { localStorage.setItem('weitvTab', name); } catch(e){}
    if (history.replaceState) history.replaceState(null, '', '#' + name);
  }
  window.showTab = showTab;
  function restoreTab(){
    var name = (location.hash || '').replace('#','');
    if (!name) { try { name = localStorage.getItem('weitvTab'); } catch(e){} }
    if (name && $('.tab[data-tab="' + name + '"]')) showTab(name);
  }

  /* ── 時鐘（台灣時間）── */
  function tick(){
    var el = $('#clock'); if (!el) return;
    var d = new Date(Date.now() + 8*3600*1000);
    var p = function(n){ return (n<10?'0':'') + n; };
    el.textContent = p(d.getUTCMonth()+1) + '/' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }
  setInterval(tick, 15000); tick();

  /* ── 裝置搜尋 / 篩選 ── */
  var devFilter = 'all', codeFilter = 'all';
  function setDevFilter(el){ devFilter = el.dataset.f; $$('.fchip', el.parentNode).forEach(function(c){ c.classList.remove('active'); }); el.classList.add('active'); filterDevs(); }
  function filterDevs(){
    var box = $('#devSearch'); var q = (box ? box.value : '').trim().toLowerCase();
    var shown = 0;
    $$('#devList .dev-card').forEach(function(card){
      var okText = !q || (card.dataset.search || '').indexOf(q) >= 0;
      var okFilter = devFilter === 'all'
        || (devFilter === 'online' && card.dataset.online === '1')
        || (devFilter === 'offline' && card.dataset.online === '0')
        || (devFilter === 'unauth' && card.dataset.authed === '0')
        || (devFilter === 'blocked' && card.dataset.blocked === '1')
        || (devFilter === 'oldver' && card.dataset.oldver === '1');
      var show = okText && okFilter; if (show) shown++;
      card.classList.toggle('hide', !show);
    });
    var e = $('#devEmpty'); if (e) e.style.display = shown ? 'none' : '';
  }
  function setCodeFilter(el){ codeFilter = el.dataset.f; $$('.fchip', el.parentNode).forEach(function(c){ c.classList.remove('active'); }); el.classList.add('active'); filterCodes(); }
  function filterCodes(){
    var box = $('#codeSearch'); var q = (box ? box.value : '').trim().toLowerCase();
    $$('#codeList .code-row').forEach(function(row){
      var okText = !q || (row.dataset.search || '').indexOf(q) >= 0;
      var okFilter = codeFilter === 'all' || row.dataset.status === codeFilter;
      row.classList.toggle('hide', !(okText && okFilter));
    });
  }
  window.setDevFilter = setDevFilter; window.filterDevs = filterDevs;
  window.setCodeFilter = setCodeFilter; window.filterCodes = filterCodes;
  function reapplyFilters(){
    var f = $('.fchip[data-f="' + devFilter + '"]', $('#devFilters') || document); if (f) { $$('.fchip', f.parentNode).forEach(function(c){ c.classList.remove('active'); }); f.classList.add('active'); }
    var g = $('.fchip[data-f="' + codeFilter + '"]', $('#codeFilters') || document); if (g) { $$('.fchip', g.parentNode).forEach(function(c){ c.classList.remove('active'); }); g.classList.add('active'); }
    filterDevs(); filterCodes();
  }

  /* ── 局部刷新 ── */
  var refreshing = false;
  function refreshParts(names, done){
    names = (names || []).filter(function(n, i, a){ return n && a.indexOf(n) === i; });
    if (!names.length) { if (done) done(); return; }
    var pending = names.length;
    names.forEach(function(name){
      var devQ = $('#devSearch') ? $('#devSearch').value : null;
      var codeQ = $('#codeSearch') ? $('#codeSearch').value : null;
      fetch('/admin/partial?name=' + encodeURIComponent(name), { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
        .then(function(r){
          if (r.status === 401) { toast('登入已失效，請重新整理頁面', false); throw new Error('401'); }
          var v = r.headers.get('X-Config-Version'); if (v) { var vp = $('#verPill b'); if (vp) vp.textContent = 'v' + v; }
          return r.text();
        })
        .then(function(html){
          var host = $('[data-part="' + name + '"]'); if (host) host.innerHTML = html;
          if (devQ != null && $('#devSearch')) $('#devSearch').value = devQ;
          if (codeQ != null && $('#codeSearch')) $('#codeSearch').value = codeQ;
          reapplyFilters();
        })
        .catch(function(){})
        .then(function(){ if (--pending === 0 && done) done(); });
    });
  }
  window.refreshParts = refreshParts;
  function refreshAll(){
    var b = $('#btnRefresh'); if (b) b.classList.add('spin');
    refreshParts(['overview','devices','codes','notice','system'], function(){ if (b) b.classList.remove('spin'); toast('已更新'); });
  }
  window.refreshAll = refreshAll;

  /* ── 表單 AJAX 送出 ── */
  document.addEventListener('submit', function(ev){
    var form = ev.target;
    if (!form || form.tagName !== 'FORM' || form.hasAttribute('data-native')) return;
    ev.preventDefault();
    var confirmText = form.getAttribute('data-confirm');
    if (confirmText && !window.confirm(confirmText)) return;
    var sub = ev.submitter || null;
    var btn = sub || form.querySelector('button[type=submit],button:not([type])');
    var oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '處理中…'; }
    var fd = new FormData(form);
    if (sub && sub.name) fd.append(sub.name, sub.value);
    var action = (sub && sub.getAttribute('formaction')) || form.getAttribute('action') || location.pathname;
    fetch(action, { method: 'POST', body: fd, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
      .then(function(r){ return r.json().then(function(j){ j.__status = r.status; return j; }); })
      .then(function(data){
        if (data.relogin) { toast('登入已失效，請重新整理頁面', false); return; }
        toast(data.message || data.error || (data.ok ? '完成' : '失敗'), data.ok !== false);
        if (data.version) { var vp = $('#verPill b'); if (vp) vp.textContent = 'v' + data.version; }
        if (data.ok && data.codes && data.codes.length) showCodesModal(data.codes, data.days, data.note);
        if (data.ok && form.hasAttribute('data-reset')) form.reset();
        if (data.refresh && data.refresh.length) refreshParts(data.refresh);
      })
      .catch(function(){ toast('連線失敗，請重試', false); })
      .then(function(){ if (btn) { btn.disabled = false; btn.textContent = oldText; } });
  });

  /* ── 啟動碼 modal ── */
  function showCodesModal(codes, days, note){
    var bg = $('#modalBg'); if (!bg) return;
    var rows = codes.map(function(c){ return '<div class="cg-row"></div>'; }).join('');
    bg.innerHTML = '<div class="modal"><h3>已產生 ' + codes.length + ' 組啟動碼</h3><div class="meta">有效期 <b>' + (days>0 ? days + ' 天' : '永久') + '</b>' + (note ? ' · 備註 <b></b>' : '') + '</div><div class="code-box">' + rows + '</div><button class="btn btn-primary" id="copyAllBtn">📋 複製全部</button><button class="btn btn-secondary" id="closeModalBtn">關閉</button></div>';
    var rowEls = $$('.cg-row', bg); codes.forEach(function(c, i){ rowEls[i].textContent = c; });
    if (note) $('.meta b:last-child', bg).textContent = note;
    bg.classList.add('show');
    $('#copyAllBtn').onclick = function(){ copyText(codes.join('\\n'), '已複製 ' + codes.length + ' 組啟動碼'); };
    $('#closeModalBtn').onclick = function(){ bg.classList.remove('show'); };
    bg.onclick = function(e){ if (e.target === bg) bg.classList.remove('show'); };
  }
  function copyText(text, okMsg){
    var done = function(){ toast(okMsg || '已複製'); };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function(){ fallback(); }); }
    else fallback();
    function fallback(){
      var ta = document.createElement('textarea'); ta.value = text; ta.className = 'sr'; document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy'); done(); } catch(e){ toast('複製失敗，請手動選取', false); }
      document.body.removeChild(ta);
    }
  }
  window.copyText = copyText;
  document.addEventListener('click', function(ev){
    var t = ev.target.closest ? ev.target.closest('[data-copy]') : null;
    if (t) { copyText(t.getAttribute('data-copy'), '已複製 ' + t.getAttribute('data-copy')); }
  });

  /* ── 測試來源 ── */
  function renderBoxesHtml(b){
    if (!b) return '';
    if (b.ok > 0) return '<div class="note-box ok">✅ 盒子實測：' + b.ok + ' 台最近成功載入（最多 ' + b.maxCount + ' 台，' + (b.recentRel || '') + '）— 這是真實結果，可放心儲存。</div>';
    if (b.reported > 0) return '<div class="note-box bad">盒子有回報，但最近未成功載入來源。</div>';
    return '<div class="note-box mute">尚無盒子回報實測（盒子裝好 App 開過後，這裡會顯示真實載入結果）。</div>';
  }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function testSource(){
    var el = $('#testResult'); var url = $('#subscriptionUrl').value.trim();
    el.style.display = 'block';
    el.innerHTML = '<div class="result-card"><div class="result-head"><div class="result-icon">…</div><div><div class="result-title">測試中</div><div class="result-sub">正在連線並解析來源</div></div></div></div>';
    var fd = new FormData(); fd.append('subscriptionUrl', url);
    fetch('/admin/test', { method: 'POST', body: fd, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(data){
        var boxesHtml = renderBoxesHtml(data.boxes);
        if (data.ok) {
          var good = data.httpOk && data.channelCount > 0;
          var hint = good ? '' : '<div class="note-box warn">⚠ 此測試是從 Cloudflare 雲端 IP 去打來源。若你的源只允許台灣／家用 IP，雲端會被擋；但電視盒是從你家網路直接連源，通常仍可正常使用，可直接儲存。</div>';
          var groups = (data.groups || []).map(function(g){ return '<span class="chip-s">' + esc(g.name) + ' <b>' + g.count + '</b></span>'; }).join('');
          var sample = (data.sample || []).length ? '<div class="inline-note">頻道範例：' + esc(data.sample.join('、')) + (data.channelCount > data.sample.length ? '…' : '') + '</div>' : '';
          var epg = data.epgUrl ? '<div class="inline-note">節目表（EPG）：<code>' + esc(data.epgUrl) + '</code></div>' : '<div class="inline-note">此清單未附節目表網址（x-tvg-url）</div>';
          el.innerHTML = '<div class="result-card ' + (good ? 'ok' : 'bad') + '"><div class="result-head"><div class="result-icon">' + (good ? '✓' : '✕') + '</div><div><div class="result-title">' + (good ? '來源正常' : '雲端測試未通過') + '</div><div class="result-sub">' + (good ? '可以儲存使用' : '雲端連不到，不代表盒子連不到') + '</div></div></div>'
            + '<div class="result-stats"><div class="stat"><div class="sk">HTTP 狀態</div><div class="sv">' + data.httpStatus + '</div></div><div class="stat"><div class="sk">M3U 格式</div><div class="sv">' + (data.looksLikeM3u ? '是' : '否') + '</div></div><div class="stat"><div class="sk">頻道數</div><div class="sv">' + data.channelCount + '</div></div><div class="stat"><div class="sk">回應</div><div class="sv">' + Math.round(data.bytes/1024) + ' KB · ' + data.ms + ' ms</div></div></div>'
            + (groups ? '<div class="chips">' + groups + '</div>' : '') + sample + epg + hint + '</div>' + boxesHtml;
        } else {
          el.innerHTML = '<div class="result-card bad"><div class="result-head"><div class="result-icon">✕</div><div><div class="result-title">測試失敗</div><div class="result-sub">' + esc(data.error || '未知錯誤') + '</div></div></div></div>' + boxesHtml;
        }
      })
      .catch(function(e){ el.innerHTML = '<div class="result-card bad"><div class="result-head"><div class="result-icon">✕</div><div><div class="result-title">測試請求失敗</div><div class="result-sub">' + esc(e.message) + '</div></div></div></div>'; });
  }
  window.testSource = testSource;

  /* ── 即時預覽（跑馬燈 / 公告）── */
  document.addEventListener('input', function(ev){
    var t = ev.target;
    if (t && t.id === 'marquee') { var pm = $('#pmText'); if (pm) pm.textContent = t.value || '（跑馬燈文字預覽）'; }
    if (t && t.id === 'notice') { var pn = $('#pnText'); if (pn) pn.textContent = t.value || '（公告文字預覽）'; }
  });

  /* ── 自動刷新：概覽 / 裝置分頁每 60 秒 ── */
  setInterval(function(){
    if (document.hidden) return;
    var active = document.activeElement; if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
    var p = $('.panel.active'); if (!p) return;
    var name = p.dataset.panel;
    if (name === 'overview' || name === 'devices') refreshParts([name === 'overview' ? 'overview' : 'devices']);
  }, 60000);

  document.addEventListener('DOMContentLoaded', function(){ restoreTab(); reapplyFilters(); });
})();
`;
