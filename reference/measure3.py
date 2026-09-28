import cv2, numpy as np, tb

def row_measure(prof, pmin=12, pmax=400, min_mod=0.25, min_amp=12):
    """One scan row -> (pitch, list of (center,width,contrast))."""
    pitch = tb.pitch_fft(prof, pmin, min(pmax, len(prof)/3))
    x = tb.detrend(prof, k=int(pitch*4)|1)
    n=len(x); t=np.arange(n)
    c=(x*np.cos(2*np.pi*t/pitch)).mean(); s=(x*np.sin(2*np.pi*t/pitch)).mean()
    amp = 2*np.hypot(c,s)
    rng = np.percentile(x,97)-np.percentile(x,3)
    mod = amp/rng if rng>1e-6 else 0
    if mod < min_mod or amp < min_amp:
        return pitch, mod, amp, []
    ph = np.arctan2(s,c)
    k0 = ph*pitch/(2*np.pi)
    centers = k0 + np.arange(-2, n/pitch+2)*pitch
    out=[]
    for cc in centers:
        if cc < pitch*0.6 or cc > n-pitch*0.6: continue
        r = _halfmax(prof, cc, pitch)
        if r: out.append(r)
    return pitch, mod, amp, out

def _halfmax(prof, center, pitch):
    lo=int(max(0,center-0.6*pitch)); hi=int(min(len(prof), center+0.6*pitch+1))
    if hi-lo<6: return None
    seg=prof[lo:hi].astype(np.float32)
    pk=int(np.argmax(seg)); top=seg[pk]; base=np.percentile(seg,12)
    con=top-base
    if con<12: return None
    half=0.5*(top+base)
    i=pk
    while i>0 and seg[i]>half: i-=1
    if seg[i]>half: return None
    xl=i+(half-seg[i])/(seg[i+1]-seg[i]+1e-9)
    j=pk
    while j<len(seg)-1 and seg[j]>half: j+=1
    if seg[j]>half: return None
    xr=j-(half-seg[j])/(seg[j-1]-seg[j]+1e-9)
    w=xr-xl
    if not (0.03*pitch<w<0.9*pitch): return None
    return (lo+(xl+xr)/2, w, con, float(top))

def analyze(gr, x0,x1,y0,y1, band=4, stride=6, **kw):
    rows=[]
    for y in range(y0+band, y1-band, stride):
        prof = gr[y-band:y+band, x0:x1].astype(np.float32).mean(axis=0)
        pitch, mod, amp, dets = row_measure(prof, **kw)
        if dets:
            rows.append((y, pitch, mod, amp, dets))
    if not rows:
        return {'ok':False, 'reason':'no rows passed the resolution gate'}
    ratios=[]; samples=[]
    for y,pitch,mod,amp,dets in rows:
        for (c,w,con,top) in dets:
            samples.append((y, x0+c, w, pitch, w/pitch, con, top))
    S=np.array(samples)
    if len(S)==0: return {'ok':False,'reason':'no detections'}
    # shadow rejection: drop samples whose bar peak is much darker than typical
    tops=S[:,6]; tref=np.percentile(tops,75)
    keep=(tops > 0.72*tref) & (S[:,5] > 25)
    if keep.sum() >= 40:
        S=S[keep]
    samples=[tuple(r) for r in S]
    ratios=S[:,4]
    return {'ok':True, 'kept':len(S), 'nrows':len(rows), 'nsamp':len(ratios),
            'pitch_med': float(np.median([r[1] for r in rows])),
            'mod_med': float(np.median([r[2] for r in rows])),
            'r_p50': float(np.percentile(ratios,50)),
            'r_p25': float(np.percentile(ratios,25)),
            'r_p10': float(np.percentile(ratios,10)),
            'r_p05': float(np.percentile(ratios,5)),
            'samples': samples}

def draw(ir, res, path, x0=0,y0=0,x1=None,y1=None, every=3):
    vis = ir[y0:y1, x0:x1].copy()
    if not res.get('ok'):
        cv2.imwrite(path, vis); return
    for k,(y,cx,w,pitch,r,con,top) in enumerate(res['samples']):
        if k%every: continue
        yy=int(y-y0); a=int(cx-x0-w/2); b=int(cx-x0+w/2)
        cv2.line(vis,(a,yy),(b,yy),(0,0,255),1)
    cv2.imwrite(path, vis)
