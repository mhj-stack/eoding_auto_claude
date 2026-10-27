import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {chromium} from 'playwright';
import {applyProductContent} from '../src/product-content-adapter.mjs';
import {prepareExistingReferenceImage,storedImageName} from '../src/display-image.mjs';
import {installProductOnlyFixture,origin,pageUrl,productId,png,pngHash,image,tenant,contentControls} from './fixtures/product-only-page.mjs';

const secondBytes=Buffer.concat([png,Buffer.from([1])]);
const secondHash=createHash('sha256').update(secondBytes).digest('hex');
// The ERP keeps a unique file name per upload: a name that already exists gets a suffix, so
// the stored name (what the image search matches) can differ from the approved source name.
const second={id:'91',src:tenant.imageUrlPrefix+'approved-next_Eq3X4Um.png'};
const receipts=[image,second];
const sources=[{kind:'upload',name:'approved-first.png',mimeType:'image/png',bytes:png,sha256:pngHash,alt:'First fixture'},
 {kind:'upload',name:'approved-next.png',mimeType:'image/png',bytes:secondBytes,sha256:secondHash,alt:'Next fixture'}];
const detail=()=>Object.fromEntries(Array.from({length:8},(_,i)=>[String(i+1),{type:String(i+1),etc:i<4?'[]':'',etc2:'',etc5:i===7?'0':'',untouched:'KEEP'}]));
const target={origin,productId,masterCode:'FIXTURE',pageUrl,controls:contentControls,endpoints:{display:`${origin}/tour/master_product/homepage/${productId}/`,detail:`${origin}/tour/master_product_detail/${productId}/change/`,reference:`${origin}/tour/master_product_reference/${productId}/change/`,upload:`${origin}/contents/image/create_modal/?managed_flag=false`}};

async function setup(t,{scenario='normal',count=1}={}){
 const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND']});t.after(()=>browser.close());
 const context=await browser.newContext({serviceWorkers:'block'}),f=await installProductOnlyFixture(context),searches=[],proofs=[],events=[];
 f.state.content.detail=detail();
 await context.exposeBinding('recordPickerSearch',(_info,query)=>{searches.push(query);});
 await context.route(second.src,r=>r.fulfill({contentType:'image/png',body:secondBytes}));
 await context.route(target.endpoints.upload,async route=>{
  const req=route.request();if(req.method()!=='POST')return route.abort();
  const form=await new Response(req.postDataBuffer(),{headers:{'content-type':req.headers()['content-type']}}).formData(),file=form.get('pc-image');
  f.writes.push({kind:'upload',name:file.name,sha256:createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex')});
  return route.fulfill({json:scenario==='duplicate upload receipt'?image:second});
 });
 await context.addInitScript(({catalog,scenario})=>{
  window.addEventListener('DOMContentLoaded',()=>{
   let handlers=[],shown=0;
   const emit=()=>{const callbacks=handlers;handlers=[];queueMicrotask(()=>callbacks.forEach(callback=>callback()));};
   const api={settings:()=>[{_bInitComplete:true}],page:{info:()=>({recordsDisplay:shown}),len:()=>({draw:emit})}};
   window.jQuery=()=>({DataTable:()=>api,one:(_event,callback)=>handlers.push(callback)});window.jQuery.fn={dataTable:{isDataTable:()=>true}};
   const openPicker=control=>{
    document.querySelector('#content-modal')?.remove();
    const modal=document.createElement('div');modal.id='content-modal';modal.innerHTML='<input id="id_title"><button class="search">Search</button><div id="modal_table"><table><tbody></tbody></table></div><div id="selected_image_area"></div><button id="import-image-btn">Import</button>';document.body.append(modal);
    modal.querySelector('button.search').onclick=()=>{
     const query=modal.querySelector('#id_title').value;window.recordPickerSearch(query);
     const matches=catalog.filter(item=>item.name===query);if(scenario==='duplicate row'&&matches.length)matches.push(matches[0]);shown=matches.length;
     const tbody=modal.querySelector('tbody');tbody.innerHTML='';
     if(!matches.length)tbody.innerHTML='<tr><td class="dataTables_empty">No matching records found</td></tr>';
     for(const item of matches){const tr=document.createElement('tr'),td=document.createElement('td'),button=document.createElement('button');button.className='select-row';button.dataset.id=item.id;button.dataset.src=scenario==='wrong source'?item.src+'?different=1':item.src;button.textContent='Select';td.append(button);tr.append(td);tbody.append(tr);
      button.onclick=()=>{const img=document.createElement('img');img.className='import-image';img.dataset.id=item.id;img.src=item.src;modal.querySelector('#selected_image_area').append(img);};}
     emit();
    };
    modal.querySelector('#import-image-btn').onclick=()=>{
     for(const img of modal.querySelectorAll('.import-image')){const row=document.createElement('div');row.className=control?'tr_image_list':'image_list';row.dataset.id=img.dataset.id;row.append(img.cloneNode());(control??document.querySelector('#image_homepage_area')).append(row);
      if(scenario==='extra attached row'&&control)control.append(row.cloneNode(true));}
     modal.hidden=true;
    };
   };
   const installSearch=control=>{if(control.querySelector('.add_reference_image'))return;const button=document.createElement('button');button.type='button';button.className='add_reference_image';button.textContent='Search existing';button.onclick=()=>openPicker(control);control.append(button);};
   const add=document.querySelector('#add_reference_element'),original=add.onclick;add.onclick=event=>{original.call(add,event);const control=document.querySelector('#reference_body .control:last-child');if(control?.dataset.type==='4')installSearch(control);};
   document.querySelectorAll('#reference_body .control[data-type="4"]').forEach(installSearch);
   document.querySelector('#image_popup').onclick=()=>openPicker(null);
   // Render the exact persisted fixture rows on a fresh GET. The shared fixture
   // originally supported one image; this extension models its second image.
   for(const control of document.querySelectorAll('#reference_body .control[data-type="4"]')){
    const ids=referenceBaseline[0].image_group.flatMap(group=>group.image_list.map(item=>item.image_id));
    control.querySelectorAll('.tr_image_list').forEach(row=>row.remove());
    for(const id of ids){const item=catalog.find(item=>item.id===id);const row=document.createElement('div');row.className='tr_image_list';row.dataset.id=id;const img=document.createElement('img');img.src=item.src;row.append(img);control.append(row);}
   }
   for(const row of document.querySelectorAll('#image_homepage_area .image_list'))row.querySelector('img').src=catalog.find(item=>item.id===row.dataset.id).src;
  });
 },{catalog:receipts.map(receipt=>({...receipt,name:storedImageName(receipt.src)})),scenario});
 const page=await context.newPage();await page.goto(pageUrl);
 const args={target,tenant,nativePayloads:true,timeoutMs:2000,identity:async()=>{},beforeWrite:async()=>({durable:true}),record:async event=>events.push(event),reconciledDetail:detail(),reconciledUploads:[{sourceSha256:pngHash,receipt:image}],
  display:{fields:{short_description:'Fixture overview'},images:[],imageQuery:'generic query with no matches',useReferenceUploads:true},
  detail:{include:[],exclude:[],information:[],mainPoints:[],shoppingCount:'0'},reference:{elements:[{type:'3',text:'Fixture title'}],images:sources.slice(0,count)},
  verifyUploadedImage:async({receipt,source})=>{proofs.push({receipt,source});assert.equal(source.mimeType,'image/png');return {tenantId:'7',src:receipt.src,sha256:source.sha256};}};
 return {...f,page,args,searches,proofs,events};
}

for(const count of [1,2])test(`reuses the first approved image and uploads only ${count-1} remaining image`,async t=>{
 const f=await setup(t,{count}),result=await applyProductContent(f.page,f.args);
 assert.equal(result.status,'content-verified',JSON.stringify(result));assert.deepEqual(result.uploads,receipts.slice(0,count));
 assert.deepEqual(f.writes.map(write=>write.kind),count===1?['reference','display']:['upload','reference','display']);
 assert.equal(result.forwarded,count+1);assert.deepEqual(f.proofs.map(proof=>proof.source.sha256),sources.slice(0,count).map(source=>source.sha256));
 if(count===2)assert.equal(f.writes[0].sha256,secondHash);
 assert.equal(f.events.filter(event=>event.phase==='upload-reconciled').length,1);
 assert.deepEqual(result.persisted.images,receipts.slice(0,count));
 assert.ok(f.searches.includes(f.args.display.imageQuery));assert.ok(f.searches.includes('90.png'));
 if(count===2){assert.ok(f.searches.includes('approved-next_Eq3X4Um.png'));assert.ok(!f.searches.includes(sources[1].name));}
});

for(const scenario of ['wrong source','duplicate row','extra attached row'])test(`reconciled image selection rejects ${scenario} before any write`,async t=>{
 const f=await setup(t,{scenario}),result=await applyProductContent(f.page,f.args);
 assert.equal(result.status,'needs-reconciliation');assert.equal(result.forwarded,0);assert.deepEqual(f.writes,[]);
 assert.match(result.message,/exactly match approval|missing or ambiguous|differs from the exact approved receipt/);
});

test('reconciled image proof is rechecked before any write or attachment',async t=>{
 const f=await setup(t);f.args.verifyUploadedImage=async()=>({tenantId:'7',src:image.src,sha256:'f'.repeat(64)});
 const result=await applyProductContent(f.page,f.args);assert.equal(result.status,'needs-reconciliation');assert.equal(result.forwarded,0);assert.match(result.message,/evidence mismatch/);assert.deepEqual(f.writes,[]);assert.deepEqual(f.searches,[]);
});

test('a later upload cannot reuse the reconciled receipt identity',async t=>{
 const f=await setup(t,{count:2,scenario:'duplicate upload receipt'}),result=await applyProductContent(f.page,f.args);
 assert.equal(result.status,'needs-reconciliation');assert.match(result.message,/receipt duplicates an earlier image/);
 assert.deepEqual(result.uploads,[image]);assert.equal(result.forwarded,1);assert.deepEqual(f.writes.map(write=>write.kind),['upload']);
});

for(const invalid of [[],[{sourceSha256:secondHash,receipt:second}],[{sourceSha256:pngHash,receipt:image},{sourceSha256:pngHash,receipt:image}],[{sourceSha256:pngHash,receipt:{...image,src:image.src.replace('/7/','/8/')}}]])test(`rejects an invalid reconciled upload binding ${JSON.stringify(invalid)}`,async t=>{
 const f=await setup(t,{count:2});f.args.reconciledUploads=invalid;
 await assert.rejects(applyProductContent(f.page,f.args),/exactly one bound first upload|first approved source|does not match tenant/);assert.deepEqual(f.writes,[]);assert.deepEqual(f.proofs,[]);
});

test('reference picker refuses a nonempty image control without changing it',async t=>{
 const f=await setup(t);await f.page.locator('.reference_element select').selectOption('4');await f.page.locator('#add_reference_element').click();const control=f.page.locator('#reference_body .control[data-type="4"]');
 await prepareExistingReferenceImage(f.page,{control,receipt:image,companyId:'7',query:storedImageName(image.src)});
 await assert.rejects(prepareExistingReferenceImage(f.page,{control,receipt:image,companyId:'7',query:storedImageName(image.src)}),/Cannot overwrite nonempty reference images/);
 assert.equal(await control.locator('.tr_image_list').count(),1);assert.deepEqual(f.writes,[]);
});
