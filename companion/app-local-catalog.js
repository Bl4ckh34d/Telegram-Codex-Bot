'use strict';
const path=require('node:path');
const os=require('node:os');
// The app's list_threads tool currently caps its sidebar snapshot at 50 rows.
// Read metadata only; never mutate Codex's database or use it to execute turns.
function localThreadCatalog(file=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'state_5.sqlite')) {
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(x=>x.name));
    const title=columns.has('name')?"COALESCE(NULLIF(name,''),title)":'title';
    const project=columns.has('project_id')?'project_id':'NULL';
    return db.prepare(`SELECT id, ${title} AS title, cwd, updated_at AS updatedAt, ${project} AS projectId FROM threads WHERE archived=0 AND source IN ('vscode','cli') ORDER BY updated_at DESC`).all()
      .map(row=>({...row,kind:'codex',hostId:'local',status:'unknown'}));
  }finally{db.close();}
}
module.exports={localThreadCatalog};
