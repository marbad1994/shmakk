// Run with the web Vite server running. API responses are mocked; no live model or terminal is used.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
 for(const [width,height] of [[320,568],[390,844],[430,932],[844,390],[768,1024],[1440,900]]) {
  const context=await browser.newContext({viewport:{width,height},hasTouch:true,isMobile:width<768});
  const page=await context.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',route=>{
   const url=route.request().url();
   const boot={version:'test',home:'/tmp',platform:'linux',workspace:'/tmp/project',hosted:false,projects:[],conversations:[],profiles:[],status:null,settings:{recentWorkspaces:[],modelByMode:{},systemPrompt:''},provider:{configured:true,models:[],registry:[],endpoints:[],model:'test',baseUrl:''},features:{terminal:false}};
   const data=url.includes('/bootstrap')?boot:url.includes('/automations')?{automations:[]}:url.includes('/models')?{models:[]}:url.includes('/servers')?{servers:[]}:url.includes('/edits')?{edits:[]}:url.includes('/plans')?{plans:[]}:{};
   return route.fulfill({json:data});
  });
  await page.goto(process.env.SHMAKK_TEST_URL || 'http://127.0.0.1:5173');
  await page.locator('#composer-input').waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow at ${width}`);
  const send=await page.getByRole('button',{name:'Send',exact:true}).boundingBox();
  assert(send.x>=0&&send.x+send.width<=width,`send outside ${width}`);
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.keyboard),'closed');
  if(width<768) {
   await page.getByRole('button',{name:'Open menu',exact:true}).click();
   await page.getByRole('button',{name:'Hide sidebar',exact:true}).click();
   const nav=page.getByRole('navigation',{name:'Primary',exact:true});
   assert.deepEqual(await nav.getByRole('button').allTextContents(),['Chat','Code','Design','Cowork','Terminal']);
   for(const name of ['Chat','Design','Cowork','Terminal','Code']) {
    await nav.getByRole('button',{name,exact:true}).click();
    assert.equal(await nav.getByRole('button',{name,exact:true}).getAttribute('aria-current'),'page');
   }
   for(const name of ['Browser','Changes','Plan']) {
    await page.getByRole('button',{name,exact:true}).click();
    const inspector=page.getByRole('complementary',{name:'Inspector'});
    await page.waitForTimeout(250);
    const bounds=await inspector.boundingBox();
    assert(Math.abs(bounds.x)<1 && Math.abs(bounds.width-width)<1,`sheet width ${width}`);
    assert(bounds.y>0 && Math.abs(bounds.y+bounds.height-height)<1,`sheet bottom ${width}`);
    await page.getByRole('button',{name:'Close inspector',exact:true}).click();
   }
   await page.evaluate(()=>{location.hash='/settings';});
   const settings=page.getByRole('dialog',{name:'Settings',exact:true});
   await settings.waitFor();
   assert(await settings.evaluate(el=>el.scrollWidth<=el.clientWidth),`settings width ${width}`);
   const settingsNav=settings.getByRole('navigation',{name:'Settings sections'});
   assert(await settingsNav.evaluate(el=>el.scrollWidth>el.clientWidth),'settings sections scroll horizontally');
   const scroller=settings.locator('.overflow-y-auto').last();
   assert(await scroller.evaluate(el=>el.scrollHeight>el.clientHeight),'settings body scrolls');
   assert(await scroller.evaluate(el=>el.scrollWidth<=el.clientWidth),`settings content width ${width}`);
   await settings.getByRole('button',{name:'Close',exact:true}).click();
   // Simulate the visual viewport changes Safari emits when opening a keyboard.
   await page.locator('#composer-input').focus();
   await page.evaluate(()=>{
    Object.defineProperty(visualViewport,'height',{configurable:true,value:innerHeight-250});
    visualViewport.dispatchEvent(new Event('resize'));
   });
   await page.waitForFunction(()=>document.documentElement.dataset.keyboard==='open');
   assert.equal(await page.getByRole('navigation',{name:'Primary',exact:true}).count(),0);
   const input=await page.locator('#composer-input').boundingBox();
   assert(input.y+input.height<=height-250,`composer obscured ${width}`);
  }
  assert.deepEqual(errors,[],`runtime errors ${width}`);
  console.log(`PASS ${width}x${height}`);
  await context.close();
 }
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
