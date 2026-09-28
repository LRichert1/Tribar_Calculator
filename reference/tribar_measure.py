#!/usr/bin/env python3
"""
Tribar corrosion measurement from photographs.

Method (per Rick's approach): bar centreline PITCH is fixed by the casting and
does not change as steel corrodes, so pitch is an internal scale reference.
Bar width divided by local pitch is a dimensionless, scale-invariant number
that can be compared between any two photos at any distance.

    width_loss = 1 - (ratio_measured / ratio_new)

BASELINE_RATIO was calibrated from 60 windows across 5 photos of new tribar,
with pixel pitch spanning a 2.4x range: 0.4744 +/- 0.0202 (4.3% CV).

Reports WIDTH loss in plan view. See notes at bottom re: section loss.
"""
import cv2, numpy as np, sys, os, tb, measure3 as m3

BASELINE_RATIO = 0.4744
BASELINE_SD    = 0.0202

# --- confidence gates -------------------------------------------------------
MIN_MODULATION = 0.30   # bars must be optically resolved
MIN_SAMPLES    = 120    # enough edge measurements in the window
MIN_RATIO      = 0.15   # below this, almost certainly a detection failure
MAX_RATIO      = 0.62   # above this, likely locked onto gap not bar

def grade(loss):
    if loss is None: return '-'
    if loss < 0.10: return '0-10%'
    if loss < 0.20: return '10-20%'
    if loss < 0.30: return '20-30%'
    if loss < 0.40: return '30-40%'
    if loss < 0.50: return '40-50%'
    return '50%+'

def analyse_image(path, nx=4, ny=3):
    im = tb.load(path)
    if im is None: raise SystemExit('cannot read '+path)
    g  = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    ang = tb.bar_angle(g)
    gr, ir = tb.rotate(g, ang), tb.rotate(im, ang)
    h,w = gr.shape
    mx,my = int(w*0.06), int(h*0.06)
    xs = np.linspace(mx, w-mx, nx+1).astype(int)
    ys = np.linspace(my, h-my, ny+1).astype(int)
    results=[]
    for i in range(nx):
        for j in range(ny):
            x0,x1,y0,y1 = xs[i],xs[i+1],ys[j],ys[j+1]
            r = m3.analyze(gr,x0,x1,y0,y1)
            rec = {'cell':f'{i},{j}','box':(x0,x1,y0,y1)}
            if not r.get('ok'):
                rec.update(ok=False, why='bars not resolved'); results.append(rec); continue
            n   = r.get('kept', r['nsamp'])
            mod = r['mod_med']; med = r['r_p50']; low = r['r_p25']
            why=None
            if mod < MIN_MODULATION:   why='low contrast (mod %.2f)'%mod
            elif n  < MIN_SAMPLES:     why='too few samples (%d)'%n
            elif med < MIN_RATIO:      why='ratio %.2f implausible - locked onto highlight/gap'%med
            elif med > MAX_RATIO:      why='ratio %.2f implausible - locked onto gap'%med
            if why:
                rec.update(ok=False, why=why, ratio=med, mod=mod, n=n)
            else:
                rec.update(ok=True, ratio=med, ratio_worst=max(low,0.0),
                           loss=1-med/BASELINE_RATIO,
                           loss_worst=1-max(low,0.0)/BASELINE_RATIO,
                           mod=mod, n=n, pitch=r['pitch_med'])
            results.append(rec)
    return ir, gr, ang, results

def report(path):
    ir,gr,ang,res = analyse_image(path)
    ok=[r for r in res if r['ok']]
    print('='*78)
    print(os.path.basename(path), ' deskew %+.2f deg   %d of %d windows measurable'
          % (ang, len(ok), len(res)))
    for r in res:
        if r['ok']:
            print('  %-4s  ratio %.3f  worst %.3f   width loss %5.1f%%  (worst %5.1f%%)  %s   n=%d'
                  % (r['cell'], r['ratio'], r['ratio_worst'], 100*r['loss'],
                     100*r['loss_worst'], grade(r['loss']), r['n']))
        else:
            print('  %-4s  REJECTED  %s' % (r['cell'], r['why']))
    if ok:
        L=np.array([r['loss'] for r in ok]); Wl=np.array([r['loss_worst'] for r in ok])
        print('  ----')
        print('  typical width loss %.1f%%   worst-area width loss %.1f%%   -> report band %s'
              % (100*np.median(L), 100*np.median(Wl), grade(np.median(Wl))))
    return res

if __name__ == '__main__':
    for p in sys.argv[1:]:
        report(p)
