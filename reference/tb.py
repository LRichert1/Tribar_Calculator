import cv2, numpy as np
from scipy.signal import find_peaks

def load(p):
    return cv2.imread(p)

def bar_angle(gray, coarse=(-30,30), step=0.25):
    """Find rotation that makes bars vertical, by maximizing variance of the
    column-mean profile (bars vertical -> strong periodic column signal)."""
    h,w = gray.shape
    best=(None,-1)
    cy,cx = h//2, w//2
    half = min(h,w)//3
    sub = gray[cy-half:cy+half, cx-half:cx+half].astype(np.float32)
    for a in np.arange(coarse[0], coarse[1]+1e-9, step):
        M = cv2.getRotationMatrix2D((sub.shape[1]/2, sub.shape[0]/2), a, 1.0)
        r = cv2.warpAffine(sub, M, (sub.shape[1], sub.shape[0]), flags=cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_REPLICATE)
        m = int(r.shape[0]*0.2)
        prof = r[m:-m,:].mean(axis=0)
        prof = prof - cv2.GaussianBlur(prof.reshape(-1,1),(1,151),0).ravel()
        v = prof.var()
        if v>best[1]: best=(a,v)
    return best[0]

def rotate(img, ang):
    h,w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w/2,h/2), ang, 1.0)
    return cv2.warpAffine(img, M, (w,h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

def detrend(prof, k=151):
    k = int(max(3, min(k, (len(prof)//2)*2-1)))|1
    bg = cv2.GaussianBlur(prof.astype(np.float32).reshape(-1,1),(1,k),0).ravel()
    return prof.astype(np.float32)-bg

def pitch_fft(prof, pmin=8, pmax=200):
    """Dominant spatial period of a 1-D profile, sub-pixel via parabolic interp."""
    x = detrend(prof)
    x = x*np.hanning(len(x))
    F = np.abs(np.fft.rfft(x, n=len(x)*4))
    freqs = np.fft.rfftfreq(len(x)*4, d=1.0)
    with np.errstate(divide='ignore'):
        per = 1.0/np.maximum(freqs,1e-12)
    m = (per>=pmin)&(per<=pmax)
    idx = np.argmax(np.where(m, F, 0))
    if idx<=0 or idx>=len(F)-1: return per[idx]
    y0,y1,y2 = F[idx-1],F[idx],F[idx+1]
    d = 0.5*(y0-y2)/(y0-2*y1+y2+1e-12)
    f = freqs[idx] + d*(freqs[1]-freqs[0])
    return 1.0/f

def edges_subpixel(prof, level):
    """Zero-crossings of (prof-level) with linear interpolation -> subpixel edges."""
    s = prof-level
    idx = np.where(np.sign(s[:-1])!=np.sign(s[1:]))[0]
    out=[]
    for i in idx:
        d = s[i+1]-s[i]
        t = 0.0 if d==0 else -s[i]/d
        out.append(i+t)
    return np.array(out)

def widths_on_line(prof, pitch, hi_is_bar=True):
    """Return (bar_widths, bar_centers) for one scan profile using a
    half-amplitude threshold computed locally over ~2 pitches."""
    p = prof.astype(np.float32)
    if not hi_is_bar: p = -p
    win = int(max(9, round(pitch*2))) | 1
    lo = cv2.erode(p.reshape(-1,1), np.ones((win,1),np.uint8)).ravel()
    hi = cv2.dilate(p.reshape(-1,1), np.ones((win,1),np.uint8)).ravel()
    lo = cv2.GaussianBlur(lo.reshape(-1,1),(1,win),0).ravel()
    hi = cv2.GaussianBlur(hi.reshape(-1,1),(1,win),0).ravel()
    amp = hi-lo
    level = lo+0.5*amp
    e = edges_subpixel(p, level)
    if len(e)<2: return np.array([]), np.array([])
    W=[];C=[]
    for a,b in zip(e[:-1], e[1:]):
        mid = int((a+b)/2)
        if mid<0 or mid>=len(p): continue
        if p[mid] > level[mid]:
            w = b-a
            if 0.05*pitch < w < 0.95*pitch:
                # reject where local contrast is too weak to trust
                if amp[mid] > 8:
                    W.append(w); C.append((a+b)/2)
    return np.array(W), np.array(C)
