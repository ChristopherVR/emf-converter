// Stage-by-stage red-eye controls through the public GDI+ effect API (GdipCreateEffect / GdipBitmapApplyEffect).
//
// Each group isolates one stage of the effect with synthetic areas:
//   fallback   one red pixel on grey in areas of several shapes and image offsets: where the centroid is the centre, where it
//              falls back to the area middle, which sector the centre pixel sits in, and the radius with offsets.
//   luma       a left class and a right class in one area: the centroid weights of red pixels (redness over an integer luma).
//   carry      two areas in one call: how much of the first area's centroid reaches the second.
//   strength   a two-valued, well-mixed field: the luma spread at which the radial strength steps.
//   highlight  one pixel against a field: when the brightest pixel is corrected completely.
//   state      sequences of calls whose last call is an all-pure-red area: its output depends on the calls before it.
// Every case records the source RGBA bytes, its areas and the native output; "state" cases record every step.
using System; using System.Drawing; using System.Collections.Generic; using System.IO; using System.IO.Compression; using System.Runtime.InteropServices; using System.Text;
public static class RedEyeStageProbe {
 [DllImport("gdiplus.dll")] static extern int GdipCreateEffect(Guid guid,out IntPtr effect);
 [DllImport("gdiplus.dll")] static extern int GdipSetEffectParameters(IntPtr effect,IntPtr p,uint size);
 [DllImport("gdiplus.dll")] static extern int GdipDeleteEffect(IntPtr effect);
 [DllImport("gdiplus.dll")] static extern int GdipCreateBitmapFromScan0(int w,int h,int stride,int format,IntPtr scan,out IntPtr bmp);
 [DllImport("gdiplus.dll")] static extern int GdipBitmapSetPixel(IntPtr bmp,int x,int y,int argb);
 [DllImport("gdiplus.dll")] static extern int GdipBitmapGetPixel(IntPtr bmp,int x,int y,out int argb);
 [DllImport("gdiplus.dll")] static extern int GdipBitmapApplyEffect(IntPtr bmp,IntPtr effect,IntPtr roi,bool aux,IntPtr data,IntPtr size);
 [DllImport("gdiplus.dll")] static extern int GdipDisposeImage(IntPtr bmp);
 static void Check(int s){if(s!=0)throw new Exception("GDI+ status "+s);}
 class Step { public int W,H; public int[][] Areas; public byte[] Src,Out; }
 class Case { public string Group,Name; public List<Step> Steps=new List<Step>(); }
 static byte[] Grey(int w,int h,int r,int g,int b){var p=new byte[w*h*4];for(int i=0;i<w*h;i++){p[i*4]=(byte)r;p[i*4+1]=(byte)g;p[i*4+2]=(byte)b;p[i*4+3]=255;}return p;}
 static void Put(byte[] p,int w,int x,int y,int r,int g,int b){int i=(y*w+x)*4;p[i]=(byte)r;p[i+1]=(byte)g;p[i+2]=(byte)b;p[i+3]=255;}
 static Step Mk(int w,int h,byte[] src,params int[][] areas){return new Step{W=w,H=h,Src=src,Areas=areas};}
 static void Apply(Step s){
  IntPtr bmp,effect,prm; int na=s.Areas.Length;
  Check(GdipCreateBitmapFromScan0(s.W,s.H,0,0x26200a,IntPtr.Zero,out bmp));
  for(int y=0;y<s.H;y++)for(int x=0;x<s.W;x++){int i=(y*s.W+x)*4;Check(GdipBitmapSetPixel(bmp,x,y,unchecked((int)0xff000000)|(s.Src[i]<<16)|(s.Src[i+1]<<8)|s.Src[i+2]));}
  Check(GdipCreateEffect(new Guid("74D29D05-69A4-4266-9549-3CC52836B632"),out effect));
  int head=IntPtr.Size*2,len=head+16*na;prm=Marshal.AllocHGlobal(len);
  Marshal.WriteInt32(prm,0,na);Marshal.WriteIntPtr(prm,IntPtr.Size,new IntPtr(prm.ToInt64()+head));
  for(int a=0;a<na;a++)for(int k=0;k<4;k++)Marshal.WriteInt32(prm,head+16*a+4*k,s.Areas[a][k]);
  Check(GdipSetEffectParameters(effect,prm,(uint)len));Check(GdipBitmapApplyEffect(bmp,effect,IntPtr.Zero,false,IntPtr.Zero,IntPtr.Zero));
  s.Out=new byte[s.Src.Length];
  for(int y=0;y<s.H;y++)for(int x=0;x<s.W;x++){int argb;Check(GdipBitmapGetPixel(bmp,x,y,out argb));int i=(y*s.W+x)*4;s.Out[i]=(byte)(argb>>16);s.Out[i+1]=(byte)(argb>>8);s.Out[i+2]=(byte)argb;s.Out[i+3]=(byte)(argb>>24);}
  Marshal.FreeHGlobal(prm);GdipDeleteEffect(effect);GdipDisposeImage(bmp);
 }
 // deterministic shuffle (linear congruential generator)
 static int[] Shuffled(int n,uint seed){var idx=new int[n];for(int i=0;i<n;i++)idx[i]=i;uint s=seed;for(int i=n-1;i>0;i--){s=unchecked(s*1664525u+1013904223u);int j=(int)(((ulong)s*(ulong)(i+1))>>32);int t=idx[i];idx[i]=idx[j];idx[j]=t;}return idx;}
 static byte[] TwoValued(int n,int lo,int hi,int centre){ // half the pixels G=B=hi, half lo (red = G + 100), centre pixel G=B=centre
  var p=Grey(n,n,0,0,0);var others=new List<int>();int c=n/2;for(int i=0;i<n*n;i++)if(i!=c*n+c)others.Add(i);var sh=Shuffled(others.Count,4242);
  for(int k=0;k<others.Count;k++){int g=k<others.Count/2?hi:lo;int q=others[sh[k]];Put(p,n,q%n,q/n,g+100,g,g);}Put(p,n,c,c,centre+100,centre,centre);return p;}
 static byte[] Pair(int n,int lo,int hi){var p=Grey(n,n,0,0,0);for(int y=0;y<n;y++)for(int x=0;x<n;x++){int g=((x*7+y*13)%2)==1?hi:lo;Put(p,n,x,y,g+80,g,g);}return p;}
 static List<Case> Build(){
  var all=new List<Case>();
  // fallback: one red pixel (255,128,128) on grey, positions in steps of two, several areas
  foreach(var a in new[]{new[]{0,0,24,24},new[]{8,8,24,24},new[]{8,0,24,24},new[]{0,8,24,24},new[]{0,0,36,20},new[]{4,6,30,30},new[]{2,2,40,14}})
   for(int y=a[1];y<a[1]+a[3];y+=2)for(int x=a[0];x<a[0]+a[2];x+=2){var c=new Case{Group="fallback",Name=string.Format("area {0}x{1} at {2},{3}, pixel {4},{5}",a[2],a[3],a[0],a[1],x,y)};var p=Grey(48,48,128,128,128);Put(p,48,x,y,255,128,128);c.Steps.Add(Mk(48,48,p,new[]{a[0],a[1],a[0]+a[2],a[1]+a[3]}));all.Add(c);}
  // luma: left half (200,16,16), right half class C (the centroid weights of red pixels)
  var classes=new List<int[]>();
  foreach(int g in new[]{20,36,60,110})foreach(int x in new[]{40,120,200})if(g+x<=255)classes.Add(new[]{g+x,g,g});
  foreach(int g in new[]{0,1,2,3,4,6,8})foreach(int b in new[]{0,1,2,3,4,6,8})foreach(int x in new[]{60,150})classes.Add(new[]{Math.Max(g,b)+x,g,b});
  foreach(var gb in new[]{new[]{20,60},new[]{20,100},new[]{40,100},new[]{60,20},new[]{100,20},new[]{100,60}})foreach(int x in new[]{40,120})if(Math.Max(gb[0],gb[1])+x<=255)classes.Add(new[]{Math.Max(gb[0],gb[1])+x,gb[0],gb[1]});
  foreach(var k in classes){var c=new Case{Group="luma",Name=string.Format("left (200,16,16), right ({0},{1},{2})",k[0],k[1],k[2])};var p=Grey(16,16,0,0,0);for(int y=0;y<16;y++)for(int x=0;x<16;x++){if(x<8)Put(p,16,x,y,200,16,16);else Put(p,16,x,y,k[0],k[1],k[2]);}c.Steps.Add(Mk(16,16,p,new[]{0,0,16,16}));all.Add(c);}
  // carry: two 24x24 areas in a 140x50 image, a heavy 3x3 block in the first
  foreach(var t in new[]{new[]{10,8,3,3,70,12,150,100},new[]{10,8,18,3,70,12,150,100},new[]{10,8,3,18,70,12,150,100},new[]{10,8,18,18,70,12,150,100},new[]{10,8,10,10,70,12,150,100},new[]{10,8,3,3,70,12,100,60},new[]{10,8,18,3,70,12,100,60},new[]{0,0,10,10,100,12,150,100},new[]{30,20,10,10,100,12,150,100},new[]{90,10,10,10,20,12,150,100},new[]{12,12,6,6,60,12,150,100}}){
   var c=new Case{Group="carry",Name=string.Format("first area at {0},{1}, block at {2},{3}, second area at {4},{5}, field luma {6} redness {7}",t[0],t[1],t[2],t[3],t[4],t[5],t[6],t[7])};var p=Grey(140,50,0,0,0);for(int y=0;y<50;y++)for(int x=0;x<140;x++)Put(p,140,x,y,t[6]+t[7],t[6],t[6]);
   for(int j=0;j<3;j++)for(int i=0;i<3;i++)Put(p,140,t[0]+t[2]+i,t[1]+t[3]+j,255,20,20);c.Steps.Add(Mk(140,50,p,new[]{t[0],t[1],t[0]+24,t[1]+24},new[]{t[4],t[5],t[4]+24,t[5]+24}));all.Add(c);}
  // carry through a middle area: it holds no red (the carry passes over it), uniform red, or faint red (the carry is chained)
  foreach(string a2 in new[]{"no red","uniform red","faint red"}){
   var c=new Case{Group="carry",Name="three areas, the middle one holds "+a2};var p=Grey(200,50,150,150,150);
   for(int y=12;y<36;y++)for(int x=110;x<134;x++)Put(p,200,x,y,250,150,150);
   for(int y=8;y<32;y++)for(int x=10;x<34;x++)Put(p,200,x,y,160,150,150);
   for(int j=0;j<3;j++)for(int i=0;i<3;i++)Put(p,200,15+i,13+j,255,20,20);
   if(a2=="uniform red")for(int y=8;y<32;y++)for(int x=60;x<84;x++)Put(p,200,x,y,250,150,150);
   if(a2=="faint red")for(int y=8;y<32;y++)for(int x=60;x<84;x++)Put(p,200,x,y,153,150,150);
   c.Steps.Add(Mk(200,50,p,new[]{10,8,34,32},new[]{60,8,84,32},new[]{110,12,134,36}));all.Add(c);}
  // strength: two-valued fields, spreads around each step
  foreach(int lo in new[]{50,70})foreach(int s in new[]{23,24,25,26,27,39,40,41,42,43,79,80,81,82,83}){var c=new Case{Group="strength",Name=string.Format("51x51 two-valued luma {0} and {1}, spread {2}",lo,lo+s,s)};c.Steps.Add(Mk(51,51,TwoValued(51,lo,lo+s,lo+s/2),new[]{0,0,51,51}));all.Add(c);}
  // highlight: one pixel against a field
  foreach(int g0 in new[]{30,60,100})for(int d=36;d<=44;d++){var c=new Case{Group="highlight",Name=string.Format("uniform field luma {0}, pixel {1} above",g0,d)};var p=Grey(15,15,g0+60,g0,g0);Put(p,15,7,7,g0+d+60,g0+d,g0+d);c.Steps.Add(Mk(15,15,p,new[]{0,0,15,15}));all.Add(c);}
  for(int b=210;b<=222;b++){var c=new Case{Group="highlight",Name=string.Format("field (255,60,0), pixel (255,60,{0})",b)};var p=Grey(15,15,255,60,0);Put(p,15,7,7,255,60,b);c.Steps.Add(Mk(15,15,p,new[]{0,0,15,15}));all.Add(c);}
  foreach(int qb in new[]{0,10,20,33})for(int pb=qb;pb<=qb+7;pb++){var c=new Case{Group="highlight",Name=string.Format("field (255,20,0), reference (255,100,{0}), pixel (255,100,{1})",qb,pb)};var p=Grey(15,15,255,20,0);Put(p,15,2,2,255,100,qb);Put(p,15,7,7,255,100,pb);c.Steps.Add(Mk(15,15,p,new[]{0,0,15,15}));all.Add(c);}
  foreach(int pg in new[]{140,141,142})foreach(int dq in new[]{-1,0,1}){var c=new Case{Group="highlight",Name=string.Format("pixel G {0}, second pixel G {1}",pg,pg+dq)};var p=Grey(31,31,120,60,60);Put(p,31,15,15,pg+60,pg,pg);Put(p,31,3,3,pg+dq+60,pg+dq,pg+dq);c.Steps.Add(Mk(31,31,p,new[]{0,0,31,31}));all.Add(c);}
  // state: the last call is an all-pure-red area; what precedes it decides its strength
  Func<int,byte[]> reset=n=>Grey(n,n,128,128,128);
  foreach(int s in new[]{0,10,24,25,26,30,40,41,60,80,81,120}){var c=new Case{Group="state",Name=string.Format("two-valued 24x24 spread {0}, then a pure red 24x24",s)};c.Steps.Add(Mk(24,24,reset(24),new[]{0,0,24,24}));c.Steps.Add(Mk(24,24,Pair(24,40,40+s),new[]{0,0,24,24}));c.Steps.Add(Mk(24,24,Grey(24,24,200,0,0),new[]{0,0,24,24}));all.Add(c);}
  foreach(int n in new[]{8,12,16,20,24,28,32,40,48}){var c=new Case{Group="state",Name=string.Format("uniform 24x24, two-valued {0}x{0} spread 120, then a pure red 24x24",n)};c.Steps.Add(Mk(24,24,Grey(24,24,120,40,40),new[]{0,0,24,24}));c.Steps.Add(Mk(n,n,Pair(n,40,160),new[]{0,0,n,n}));c.Steps.Add(Mk(24,24,Grey(24,24,200,0,0),new[]{0,0,24,24}));all.Add(c);}
  foreach(var seq in new[]{"S120 grey T","S120 uniform T","S120 S30 T","S120 T T"}){string nm=seq=="S120 grey T"?"reset, spread 120, grey (no red), pure red":seq=="S120 uniform T"?"reset, spread 120, uniform, pure red":seq=="S120 S30 T"?"reset, spread 120, spread 30, pure red":"reset, spread 120, pure red, pure red";var c=new Case{Group="state",Name="24x24: "+nm};c.Steps.Add(Mk(24,24,reset(24),new[]{0,0,24,24}));
   foreach(var tok in seq.Split(' ')){byte[] p=tok=="S120"?Pair(24,40,160):tok=="S30"?Pair(24,40,70):tok=="grey"?reset(24):tok=="uniform"?Grey(24,24,120,40,40):Grey(24,24,200,0,0);c.Steps.Add(Mk(24,24,p,new[]{0,0,24,24}));}all.Add(c);}
  return all;
 }
 // Runs ONE sequence of calls in this process and returns one JSON object per step (source and output as base64). A spec is
 // ';'-separated tokens, each a whole-image area: R<n> pure red n x n (200,0,0); G<n> grey (128,128,128); U<n> uniform (120,40,40);
 // P<n>:<lo>:<hi> the checker field of the stage probe; T<n>:<g> a pure-red field with a lone pixel of green g at the centre.
 // The driver (redeye-state in generate.ps1) starts a fresh process per spec to separate in-process history from anything persistent.
 static byte[] Hsv(double h,double s,double v){double c=v*s,hp=h/60.0,x=c*(1-Math.Abs(hp%2-1)),m=v-c,r=0,g=0,b=0;
  if(hp<1){r=c;g=x;}else if(hp<2){r=x;g=c;}else if(hp<3){g=c;b=x;}else if(hp<4){g=x;b=c;}else if(hp<5){r=x;b=c;}else{r=c;b=x;}
  return new[]{(byte)Math.Round((r+m)*255),(byte)Math.Round((g+m)*255),(byte)Math.Round((b+m)*255)};}
 // The generator's test images (GdiFixtures.cs FxImages), reproduced bit for bit.
 static byte[] Ramps(){var p=new byte[256*64*4];for(int y=0;y<64;y++)for(int x=0;x<256;x++){int r,g,b;byte[] c;
   switch(y/8){case 0:r=g=b=x;break;case 1:r=x;g=b=0;break;case 2:g=x;r=b=0;break;case 3:b=x;r=g=0;break;
    case 4:c=Hsv(x*360.0/256,1,1);r=c[0];g=c[1];b=c[2];break;case 5:c=Hsv(x*360.0/256,0.5,0.75);r=c[0];g=c[1];b=c[2];break;
    case 6:c=Hsv(x*360.0/256,1,0.4);r=c[0];g=c[1];b=c[2];break;default:r=x;g=255-x;b=128;break;}
   Put(p,256,x,y,r,g,b);}return p;}
 static byte[] Eyes(){var p=new byte[96*48*4];for(int y=0;y<48;y++)for(int x=0;x<96;x++){uint v=0xFFD8A888u;bool done=false;
   for(int e=0;e<2&&!done;e++){int dx=x-(24+48*e),dy=y-24,d2=dx*dx+dy*dy;if(d2<=36){v=e==0?0xFFD02020u:0xFFC03850u;done=true;}else if(d2<=144){v=0xFFF4F0EAu;done=true;}}
   if(!done&&x>=44&&x<52&&y>=40)v=0xFFE02018u;
   Put(p,96,x,y,(int)((v>>16)&255),(int)((v>>8)&255),(int)(v&255));}return p;}
 public static string RunSequence(string spec){
  using(var init=new Bitmap(1,1)){
  var sb=new StringBuilder("[");bool first=true;
  foreach(var tok in spec.Split(';')){
   char k=tok[0];var parts=tok.Substring(1).Split(':');int n=k=='K'||k=='Q'?0:int.Parse(parts[0]);int W=n,H=n;byte[] p;int[][] areas=null;
   if(k=='R')p=Grey(n,n,200,0,0);else if(k=='G')p=Grey(n,n,128,128,128);else if(k=='U')p=Grey(n,n,120,40,40);
   else if(k=='P')p=Pair(n,int.Parse(parts[1]),int.Parse(parts[2]));
   else if(k=='T'){p=Grey(n,n,200,0,0);int g=int.Parse(parts[1]);Put(p,n,n/2,n/2,g+100,g,g);}
   else if(k=='Z'){ // the independent probe's noise field (pattern 3) with <parts[1]> pixels, chosen by a fixed shuffle, replaced by pure red (luma 0)
    int kz=int.Parse(parts[1]);int blue=parts.Length>2?int.Parse(parts[2]):0;p=Grey(n,n,0,0,0);
    for(int y=0;y<n;y++)for(int x=0;x<n;x++)Put(p,n,x,y,(x*17+y*31)%156+100,(x*3+y*5)%64,blue);
    var sh=Shuffled(n*n,777);for(int q=0;q<kz;q++){int pix=sh[q];Put(p,n,pix%n,pix/n,200,0,0);}}
   else if(k=='I'){ // the independent probe's scene <size>:<pattern>:<blue> (RedEyeCorrectionProbe, not held out), alone in a fresh process
    int pattern=int.Parse(parts[1]);int blue=int.Parse(parts[2]);int size=n;p=Grey(n,n,0,0,0);
    for(int y=0;y<n;y++)for(int x=0;x<n;x++){int r=200,g=blue,b=blue;double d=Math.Sqrt((x+.5-n/2.0)*(x+.5-n/2.0)+(y+.5-n/2.0)*(y+.5-n/2.0));
     if((pattern==1&&d<size/6.0)||(pattern==4&&d<size*.3)||(pattern==5&&d<size*.4)){r=100;g=0;b=blue;}
     if(pattern==2){g=x<n/2?blue:40;b=blue;}
     if(pattern==3){r=(x*17+y*31)%156+100;g=(x*3+y*5)%64;b=blue;}
     Put(p,n,x,y,r,g,b);}}
   else if(k=='Y'){ // Y<size>:<pattern>:<blue>:<x>:<y>: the independent scene with one faint red pixel (blue+1, blue, blue) at x,y, nudging a symmetric centroid
    int pattern=int.Parse(parts[1]);int blue=int.Parse(parts[2]);int size=n;p=Grey(n,n,0,0,0);
    for(int y=0;y<n;y++)for(int x=0;x<n;x++){int r=200,g=blue,b=blue;double d=Math.Sqrt((x+.5-n/2.0)*(x+.5-n/2.0)+(y+.5-n/2.0)*(y+.5-n/2.0));
     if((pattern==1&&d<size/6.0)||(pattern==4&&d<size*.3)||(pattern==5&&d<size*.4)){r=100;g=0;b=blue;}
     if(pattern==2){g=x<n/2?blue:40;b=blue;}
     Put(p,n,x,y,r,g,b);}
    Put(p,n,int.Parse(parts[3]),int.Parse(parts[4]),blue+1,blue,blue);}
   else if(k=='F'){ // F<w>:<h>:<lo>:<hi>:<x>:<y>: grey, no redness. Inside the disc of radius min(w,h)/2 the field is lo, outside hi (the luma spread
    // sets the strength; the disc around the lone red pixel is uniform, so its sector has no darkness term). One red pixel (lo+127, lo, lo) at x,y.
    W=n;H=int.Parse(parts[1]);int lo=int.Parse(parts[2]),hi=int.Parse(parts[3]),px=int.Parse(parts[4]),py=int.Parse(parts[5]);p=Grey(W,H,0,0,0);
    double rad=Math.Min(W,H)/2.0;
    for(int y=0;y<H;y++)for(int x=0;x<W;x++){int g=Math.Sqrt((x+.5-W/2.0)*(x+.5-W/2.0)+(y+.5-H/2.0)*(y+.5-H/2.0))<rad?lo:hi;Put(p,W,x,y,g,g,g);}
    Put(p,W,px,py,lo+127,lo,lo);}
   else if(k=='K'){ // K<area>: the fixture generator's 256 x 64 ramps image (FxImages.Ramps) with the fixture's area list: 'w' whole image, 'b' both, 'l' left
    W=256;H=64;p=Ramps();if(parts.Length>1){for(int y=0;y<64;y++)if(parts[1].IndexOf((char)('0'+y/8))<0)for(int x=0;x<256;x++)Put(p,256,x,y,128,128,128);} // K<area>:<bands>: keep only the listed 8-row bands (0 grey, 1 red, 2 green, 3 blue, 4 hue, 5 desaturated hue, 6 dark hue, 7 (x,255-x,128)), the rest mid grey
    if(parts.Length>4){int px=int.Parse(parts[2]),py=int.Parse(parts[3]),sz=int.Parse(parts[4]);for(int y=py;y<py+sz;y++)for(int x=px;x<px+sz;x++)Put(p,256,x,y,255,1,1);} // K<area>:<bands>:<x>:<y>:<size> adds a size x size block of (255,1,1) (centroid weight 254 per pixel) at x,y
    areas=parts[0]=="w"?new[]{new[]{0,0,256,64}}:parts[0]=="b"?new[]{new[]{12,12,36,36},new[]{60,12,84,36}}:new[]{new[]{12,12,36,36}};}
   else if(k=='Q'){ // Q<area>: the generator's 96 x 48 eyes image (FxImages.Eyes) with the fixture's area list ('w','b','l' as for K)
    W=96;H=48;p=Eyes();areas=parts[0]=="w"?new[]{new[]{0,0,96,48}}:parts[0]=="b"?new[]{new[]{12,12,36,36},new[]{60,12,84,36}}:new[]{new[]{12,12,36,36}};}
   else if(k=='B'){ // B<w>:<h>:<y0>:<rows>:<bx>:<by>: a mid grey field with `rows` rows of the pure red ramp (x,0,0) from row y0 (as the generator's red ramp band) and a 4 x 4 block of (255,1,1) at bx,by: the block puts the centroid beyond the fallback circle
    int bg=parts.Length>9?int.Parse(parts[9]):128; // optional: the field grey level (default 128)
    W=n;H=int.Parse(parts[1]);int y0=int.Parse(parts[2]),nr=int.Parse(parts[3]),bx=int.Parse(parts[4]),by=int.Parse(parts[5]);p=Grey(W,H,bg,bg,bg);
    int xs=parts.Length>6?int.Parse(parts[6]):0,xe=parts.Length>7?int.Parse(parts[7]):W; // optional: the ramp only spans columns xs..xe-1 (B<...>:<xs>:<xe>); a negative bx puts no block
    int gb=parts.Length>8?int.Parse(parts[8]):0; // optional: the band is (x + gb, gb, gb) instead of (x, 0, 0): redness x, integer luma gb
    for(int y=y0;y<y0+nr&&y<H;y++)for(int x=xs;x<xe&&x<W;x++)Put(p,W,x,y,Math.Min(255,x%256+gb),gb,gb);
    if(bx>=0)for(int y=by;y<by+4;y++)for(int x=bx;x<bx+4;x++)Put(p,W,x,y,255,1,1);}
   else if(k=='H'){ // H<w>:<h>:<seed>: a held-out scene from a seeded generator: a smooth coloured field with noise and one to three red clusters of random size, position and colour (some far from the middle: the fallback regime)
    W=n;H=int.Parse(parts[1]);uint sd=uint.Parse(parts[2])*2654435761u+12345u;Func<int,int> rnd=m=>{sd=unchecked(sd*1664525u+1013904223u);return (int)((sd>>8)%(uint)m);};
    int baseG=15+rnd(190),gx=rnd(61)-30,gy=rnd(61)-30,tintB=rnd(41)-20;p=new byte[W*H*4];
    for(int y=0;y<H;y++)for(int x=0;x<W;x++){int g=Math.Max(0,Math.Min(255,baseG+(gx*x/Math.Max(1,W))+(gy*y/Math.Max(1,H))+rnd(9)-4));int b=Math.Max(0,Math.Min(255,g+tintB+rnd(3)-1));int r=Math.Min(255,g+rnd(12));Put(p,W,x,y,r,g,b);}
    int clusters=1+rnd(3);for(int c=0;c<clusters;c++){int cs=3+rnd(18),cx0=rnd(Math.Max(1,W-cs)),cy0=rnd(Math.Max(1,H-cs)),cr=140+rnd(116),cg=rnd(81),cb=rnd(81);
     for(int y=cy0;y<cy0+cs&&y<H;y++)for(int x=cx0;x<cx0+cs&&x<W;x++)Put(p,W,x,y,Math.Min(255,cr+rnd(9)),cg+rnd(7),cb+rnd(7));}}
   else throw new Exception("token "+tok);
   var s=Mk(W,H,p,areas??new[]{new[]{0,0,W,H}});Apply(s);
   if(!first)sb.Append(',');first=false;
   sb.Append("{\"token\":\""+tok+"\",\"width\":"+W+",\"height\":"+H+",\"source\":\""+Convert.ToBase64String(s.Src)+"\",\"output\":\""+Convert.ToBase64String(s.Out)+"\"}");
  }
  sb.Append(']');return sb.ToString();}
 }
 public static void Run(string dir){
  Directory.CreateDirectory(dir);var cases=Build();using(var init=new Bitmap(1,1)){var sb=new StringBuilder("[");bool first=true;
  foreach(var c in cases){foreach(var s in c.Steps)Apply(s);
   if(!first)sb.Append(',');first=false;sb.Append("{\"group\":\""+c.Group+"\",\"name\":\""+c.Name+"\",\"steps\":[");
   for(int k=0;k<c.Steps.Count;k++){var s=c.Steps[k];if(k>0)sb.Append(',');sb.Append("{\"width\":"+s.W+",\"height\":"+s.H+",\"areas\":[");for(int a=0;a<s.Areas.Length;a++){if(a>0)sb.Append(',');sb.Append("["+string.Join(",",s.Areas[a])+"]");}
    sb.Append("],\"source\":\""+Convert.ToBase64String(s.Src)+"\",\"output\":\""+Convert.ToBase64String(s.Out)+"\"}");}
   sb.Append("]}");}
  sb.Append(']');var bytes=Encoding.UTF8.GetBytes(sb.ToString());
  using(var f=File.Create(Path.Combine(dir,"redeye-stages.json.gz")))using(var z=new GZipStream(f,CompressionMode.Compress))z.Write(bytes,0,bytes.Length);}
 }
}
