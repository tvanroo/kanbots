// Rebuild platform icon containers from the approved Growing master on macOS.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const master=path.join(root,'docs/assets/brand/kanborg/growing-master.png');
const build=path.join(root,'packages/desktop/build');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kanborg-icons-'));
const iconset=path.join(temp,'KanBorg.iconset');fs.mkdirSync(iconset);
const resize=(size,to)=>execFileSync('sips',['-z',String(size),String(size),master,'--out',to],{stdio:'ignore'});
try {
 for(const size of [16,32,128,256,512]){
  resize(size,path.join(iconset,`icon_${size}x${size}.png`));
  resize(size*2,path.join(iconset,`icon_${size}x${size}@2x.png`));
 }
 execFileSync('iconutil',['-c','icns',iconset,'-o',path.join(build,'icon.icns')]);
 resize(1024,path.join(build,'icon.png'));
 resize(256,path.join(root,'packages/web/src/assets/kanborg-icon.png'));
 const sizes=[16,32,48,64,128,256];const images=sizes.map(n=>{const p=path.join(temp,`${n}.png`);resize(n,p);return fs.readFileSync(p);});
 const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
 sizes.forEach((n,i)=>{const p=6+i*16;header[p]=n===256?0:n;header[p+1]=n===256?0:n;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(images[i].length,p+8);header.writeUInt32LE(offset,p+12);offset+=images[i].length;});
 fs.writeFileSync(path.join(build,'icon.ico'),Buffer.concat([header,...images]));
 console.log('Built macOS, Windows, PNG and in-app icons from Growing master.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
