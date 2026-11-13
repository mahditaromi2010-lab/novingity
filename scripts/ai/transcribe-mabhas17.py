#!/usr/bin/env python3
"""Re-transcribe Mabhas 17 pages with a vision model (gemini-3.1-pro-preview won the accuracy test vs gpt-5.4-mini;
claude-sonnet-5-5 was equally accurate but ~30x the tokens). Resumable.
  MABHAS17_PDF=path.pdf AI_API_KEY=... OUT_DIR=work python3 scripts/ai/transcribe-mabhas17.py 1 259
then: node scripts/ai/build-mabhas17-chunks.js work/pages --vision work/vis"""
import base64,json,os,sys,time,urllib.request,concurrent.futures as cf,subprocess
SP=os.environ.get('OUT_DIR','mabhas17-work'); key=os.environ['AI_API_KEY']; MODEL=os.environ.get('MODEL','gemini-3.1-pro-preview')
PDF=os.environ['MABHAS17_PDF']
PROMPT=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'transcribe-prompt.txt')).read()
os.makedirs(os.path.join(SP,'vis'),exist_ok=True); os.makedirs(os.path.join(SP,'img'),exist_ok=True)
def one(n):
    out=os.path.join(SP,'vis',f'p{n:03d}.json')
    if os.path.exists(out): return n,'skip'
    img=os.path.join(SP,'img',f'v-{n:03d}.png')
    if not os.path.exists(img):
        subprocess.run(['pdftoppm','-r','130','-f',str(n),'-l',str(n),'-png','-singlefile',PDF,img[:-4]],check=True)
    b=base64.b64encode(open(img,'rb').read()).decode()
    body={"model":MODEL,"max_tokens":8000,"reasoning_effort":"low","messages":[{"role":"user","content":[{"type":"text","text":PROMPT},{"type":"image_url","image_url":{"url":"data:image/png;base64,"+b}}]}]}
    for attempt in range(4):
        try:
            t=time.time()
            req=urllib.request.Request("https://api.gapapi.com/v1/chat/completions",data=json.dumps(body).encode(),headers={"Authorization":"Bearer "+key,"Content-Type":"application/json"})
            d=json.load(urllib.request.urlopen(req,timeout=240))
            txt=d["choices"][0]["message"]["content"]
            json.dump({"pdf_page":n,"model":MODEL,"usage":d.get("usage",{}),"secs":round(time.time()-t,1),"text":txt},open(out,'w'),ensure_ascii=False)
            return n,'ok'
        except Exception as e:
            err=str(e); time.sleep(5*(attempt+1))
    return n,'fail '+err
pages=range(int(sys.argv[1]),int(sys.argv[2])+1)
with cf.ThreadPoolExecutor(int(os.environ.get('PAR','6'))) as ex:
    for n,s in ex.map(one,pages): print(n,s,flush=True)
