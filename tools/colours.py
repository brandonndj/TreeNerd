"""Colour-blindness checks for the site's colours.

Simulates protanopia and deuteranopia (red-green) and tritanopia (blue-yellow) with the matrices of
Machado, Oliveira and Fernandes (2009) at full severity, and measures how far apart two colours look
with CIEDE2000 (about 10 is hard to tell apart; under 5 looks the same). tests/test_colours.py uses it
to keep every set of colours that carries meaning distinguishable.

    python tools/colours.py <palette.json>      # report the closest pairs for each palette
"""
import json, math, sys, itertools
M = {  # Machado 2009, severity 1.0, applied in linear RGB
 "normal": [[1,0,0],[0,1,0],[0,0,1]],
 "protan": [[0.152286,1.052583,-0.204868],[0.114503,0.786281,0.099216],[-0.003882,-0.048116,1.051998]],
 "deutan": [[0.367322,0.860646,-0.227968],[0.280085,0.672501,0.047413],[-0.011820,0.042940,0.968881]],
 "tritan": [[1.255528,-0.076749,-0.178779],[-0.078411,0.930809,0.147602],[0.004733,0.691367,0.303900]],
}
lin = lambda c: c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
gam = lambda c: 12.92*c if c <= 0.0031308 else 1.055*c**(1/2.4)-0.055
def hexrgb(h): h=h.lstrip('#'); return [int(h[i:i+2],16)/255 for i in (0,2,4)]
def sim(h, kind):
    r=[lin(x) for x in hexrgb(h)]; m=M[kind]
    return [min(1,max(0,sum(m[i][j]*r[j] for j in range(3)))) for i in range(3)]  # linear
def lab(linrgb):
    r,g,b=linrgb
    X=(0.4124*r+0.3576*g+0.1805*b)/0.95047; Y=(0.2126*r+0.7152*g+0.0722*b); Z=(0.0193*r+0.1192*g+0.9505*b)/1.08883
    f=lambda t: t**(1/3) if t>0.008856 else 7.787*t+16/116
    return (116*f(Y)-16, 500*(f(X)-f(Y)), 200*(f(Y)-f(Z)))
def de2000(a, b):
    L1,a1,b1=a; L2,a2,b2=b
    C1=math.hypot(a1,b1); C2=math.hypot(a2,b2); Cb=(C1+C2)/2
    G=0.5*(1-math.sqrt(Cb**7/(Cb**7+25**7))); a1p=(1+G)*a1; a2p=(1+G)*a2
    C1p=math.hypot(a1p,b1); C2p=math.hypot(a2p,b2)
    h1p=math.degrees(math.atan2(b1,a1p))%360; h2p=math.degrees(math.atan2(b2,a2p))%360
    dL=L2-L1; dC=C2p-C1p
    dh=0 if C1p*C2p==0 else (h2p-h1p if abs(h2p-h1p)<=180 else h2p-h1p-360 if h2p>h1p else h2p-h1p+360)
    dH=2*math.sqrt(C1p*C2p)*math.sin(math.radians(dh/2))
    Lb=(L1+L2)/2; Cbp=(C1p+C2p)/2
    hb=(h1p+h2p)/2 if abs(h1p-h2p)<=180 else (h1p+h2p+360)/2 if h1p+h2p<360 else (h1p+h2p-360)/2
    if C1p*C2p==0: hb=h1p+h2p
    T=1-0.17*math.cos(math.radians(hb-30))+0.24*math.cos(math.radians(2*hb))+0.32*math.cos(math.radians(3*hb+6))-0.20*math.cos(math.radians(4*hb-63))
    SL=1+0.015*(Lb-50)**2/math.sqrt(20+(Lb-50)**2); SC=1+0.045*Cbp; SH=1+0.015*Cbp*T
    RT=-2*math.sqrt(Cbp**7/(Cbp**7+25**7))*math.sin(math.radians(60*math.exp(-((hb-275)/25)**2)))
    return math.sqrt((dL/SL)**2+(dC/SC)**2+(dH/SH)**2+RT*(dC/SC)*(dH/SH))
VISION = ["normal", "protan", "deutan", "tritan"]


def closest(colours: dict[str, str], vision: str):
    """(ΔE, name, name) of the two colours that look most alike to someone with this kind of vision."""
    L = {k: lab(sim(v, vision)) for k, v in colours.items()}
    return min((de2000(L[a], L[b]), a, b) for a, b in itertools.combinations(colours, 2))


def against(colours: dict[str, str], background: str, vision: str):
    """(ΔE, name) of the colour that stands out least from the background."""
    bg = lab(sim(background, vision))
    return min((de2000(lab(sim(v, vision)), bg), k) for k, v in colours.items())


def report(name, pal, bg=None):
    out={}
    for kind in M:
        L={k: lab(sim(v,kind)) for k,v in pal.items()}
        pairs=sorted(((de2000(L[a],L[b]),a,b) for a,b in itertools.combinations(pal,2)))
        bgd=min(de2000(L[k], lab(sim(bg,kind))) for k in pal) if bg else None
        out[kind]=(pairs[0], pairs[1] if len(pairs)>1 else None, bgd)
    print(f"== {name}")
    for kind,(p0,p1,bgd) in out.items():
        s=f"  {kind:7s} closest {p0[1]}/{p0[2]} ΔE {p0[0]:5.1f}"
        if p1: s+=f"; next {p1[1]}/{p1[2]} {p1[0]:5.1f}"
        if bgd is not None: s+=f"; nearest to background {bgd:5.1f}"
        print(s)
if __name__ == "__main__":
    for name, (pal, bg) in json.load(open(sys.argv[1])).items(): report(name, pal, bg)
