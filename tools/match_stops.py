"""Match each route-relation stop to an OSM station feature, then to a CSV row + line column.
Writes stop_matches.json and prints a report. Run: python3 -I match_stops.py"""
import json,csv,re,math,collections,unicodedata
CSV="/mnt/user-data/uploads/751af043-Copy_of_Station_depths.csv"
ST="/mnt/user-data/uploads/36ce673a-stations.geojson"
RL="/mnt/user-data/uploads/b8f5f373-raw_lines.json"
def norm(s):
    s=unicodedata.normalize("NFKD",s).encode("ascii","ignore").decode().lower()
    s=s.replace("&","and").replace("'","").replace("’","")
    s=re.sub(r"[^a-z0-9 ]"," ",s); return re.sub(r"\s+"," ",s).strip()
def hav(a,b):
    R=6371000;p=math.pi/180
    dl=(b[0]-a[0])*p;dp=(b[1]-a[1])*p
    x=math.sin(dp/2)**2+math.cos(a[1]*p)*math.cos(b[1]*p)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(x))
LINECOL={"Metropolitan":"Metropoliton"}
# CSV: row name -> {line: [values]}
r=list(csv.reader(open(CSV,encoding="utf-8-sig")))
cols=[];line=None
for i,h in enumerate(r[0]):
    if h.strip(): line=h.strip()
    cols.append(line)
rows={}
for row in r[2:]:
    if not row or not row[0].strip() or len(row)<3 or not row[1].strip(): continue
    d=collections.defaultdict(list)
    for i in range(2,min(22,len(row))):
        v=row[i].strip()
        if v:
            try: d[cols[i]].append(float(v))
            except: pass
    rows[row[0].strip()]={"ground":float(row[1]),"lines":dict(d)}
st=[(ft["properties"]["name"],ft["geometry"]["coordinates"],ft["properties"]["osm_id"]) for ft in json.load(open(ST))["features"]]
rel=json.load(open(RL))["elements"]
by=collections.defaultdict(dict)   # line -> station name -> (dist, stopcoord)
for rr in rel:
    ref=rr["tags"].get("ref") or rr["tags"].get("name","").split(" line")[0]
    if "sidings" in rr["tags"].get("name",""): continue
    for m in rr["members"]:
        if m["type"]=="node" and m.get("role","").startswith("stop"):
            c=(m["lon"],m["lat"])
            n,sc,oid=min(st,key=lambda s:hav(c,s[1]))
            dist=hav(c,sc)
            prev=by[ref].get(n)
            if prev is None or dist<prev[0]: by[ref][n]=(dist,c,oid)
json.dump({k:{n:list(v) for n,v in d.items()} for k,d in by.items()},open("stop_matches_raw.json","w"))
print({k:len(v) for k,v in by.items()})
far=[(k,n,round(v[0])) for k,d in by.items() for n,v in d.items() if v[0]>150]
print("stops >150 m from nearest station feature:",far)
# CSV candidates per (line, station)
rown=collections.defaultdict(list)
for n in rows: rown[norm(re.sub(r"\(.*?\)","",n))].append(n)
unmatched=[];multi=[]
for ref,d in sorted(by.items()):
    col=LINECOL.get(ref,ref)
    for n in sorted(d):
        k=norm(re.sub(r"\(.*?\)","",n))
        cands=rown.get(k,[])
        cands=[c for c in cands if col in rows[c]["lines"]]
        if not cands:
            alt=[c for c in rown.get(k,[])]
            unmatched.append((ref,n,alt))
        elif len(cands)>1: multi.append((ref,n,cands))
print("\nNO CSV value for (line, station):",len(unmatched))
for u in unmatched:print("  ",u)
print("\nMULTI candidates:",len(multi))
for u in multi:print("  ",u)

# ---- second pass: aliases + fallbacks ----
ALIAS={"london liverpool street":"liverpool street","totteridge and whetstone":"totteridge",
 "heathrow terminals 2 and 3":"heathrow airport terminal 1 2 and 3","st james s park":"st jamess park"}
def rowkeys(n):
    k=norm(re.sub(r"\(.*?\)","",n)); return ALIAS.get(k,k)
rown2=collections.defaultdict(list)
for n in rows: rown2[norm(re.sub(r"\(.*?\)","",n))].append(n)
def find_rows(stn):
    k=norm(re.sub(r"\(.*?\)","",stn)); k=ALIAS.get(k,k)
    if k in rown2: return rown2[k]
    k2=k.replace("st ","st ").replace("queens","queens")
    return [v for kk,vs in rown2.items() for v in vs if kk.replace(" ","")==k.replace(" ","")]
# which CSV line columns are acceptable fallbacks for lines that share tracks
SHARED={"Circle":["Hammersmith & City","District","Metropolitan"],
        "Hammersmith & City":["District","Metropolitan","Circle"],
        "Metropolitan":["Hammersmith & City","District"],
        "Bakerloo":[],"Piccadilly":["District","Metropolitan"]}
out={};still=[];unk=[]
for ref,d in sorted(by.items()):
    col=LINECOL.get(ref,ref)
    for n,(dist,c,oid) in sorted(d.items()):
        rs=find_rows(n)
        if not rs: unk.append((ref,n)); continue
        pick=[x for x in rs if col in rows[x]["lines"]]
        how="own line"
        if not pick:
            for alt in SHARED.get(ref,[]):
                a=LINECOL.get(alt,alt)
                pick=[x for x in rs if a in rows[x]["lines"]]
                if pick: how="shared track: "+alt; break
        if not pick:
            pick=[x for x in rs if rows[x]["lines"]]; how="any other line" if pick else ""
        if not pick: still.append((ref,n,rs)); continue
        out[f"{ref}|{n}"]={"csv_rows":pick,"how":how}
print("\nNo OSM-name->CSV row at all:",unk)
print("Rows exist but no platform value on any line:",still)
hows=collections.Counter(v["how"].split(":")[0] for v in out.values()); print(hows)
amb=[(k,v) for k,v in out.items() if len(v["csv_rows"])>1]
print("ambiguous (multiple CSV rows):",len(amb))
for k,v in amb: print("  ",k,v["csv_rows"])
print("\nnon-own-line fallbacks:")
for k,v in out.items():
    if v["how"]!="own line": print("  ",k,"->",v["csv_rows"],v["how"])
json.dump(out,open("stop_to_csv.json","w"),indent=1)
