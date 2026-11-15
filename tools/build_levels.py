"""Step 1a: platform level per (line, station) from the TfL CSV, matched to OSM route stops.
Needs match_stops.py in the same folder (and the 3 input files; edit paths at top of match_stops.py).
Output: station_levels.csv  (platform_m_OD = CSV value - 100, mean of the directions)."""
import collections,csv,io,sys
buf=io.StringIO();old=sys.stdout;sys.stdout=buf
ns={};exec(compile(open("match_stops.py").read(),"match_stops","exec"),ns);sys.stdout=old
rows,by,find_rows,LINECOL,SHARED=ns["rows"],ns["by"],ns["find_rows"],ns["LINECOL"],ns["SHARED"]
by["Northern"].pop("Cannon Street",None)   # Northern Bank platforms sit nearer the Cannon Street node than the Bank node
def levels(rs,col): return [x for r in rs for x in rows[r]["lines"].get(col,[])]
def pick(ref,rs):
    col=LINECOL.get(ref,ref)
    for c,how in [(col,"own line")]+[(LINECOL.get(a,a),"shared track: "+a) for a in SHARED.get(ref,[])]:
        v=levels(rs,c)
        if v: return v,how
    return [x for r in rs for l in rows[r]["lines"].values() for x in l],"other line at same station"
res={}
for ref,d in sorted(by.items()):
    for n in sorted(d):
        if n in ("Camden Town","Euston","Kennington"):      # CSV has separate City / Charing X branch rows
            for br,tag in (("City","Bank"),("Charing X","Charing Cross")):
                if ref=="Victoria" and br=="Charing X": continue
                rs=[x for x in rows if x.startswith(n) and br in x]
                v,how=pick(ref,rs)
                if v: res[(ref,n,tag)]=(v,how,rs)
            continue
        rs=find_rows(n)
        if not rs: print("NO ROW",ref,n);continue
        v,how=pick(ref,rs); res[(ref,n,"")]=(v,how,rs)
with open("station_levels.csv","w",newline="") as f:
    w=csv.writer(f);w.writerow(["line","osm_station","branch","csv_row(s)","platform_m_OD","values_LU_datum","ground_m_OD","platform_minus_ground","how"])
    for (ref,n,br),(v,how,rs) in sorted(res.items()):
        g=rows[rs[0]]["ground"];p=sum(v)/len(v)-100
        w.writerow([ref,n,br,"; ".join(rs),round(p,1),"/".join(map(str,v)),g,round(p-g,1),how])
print(len(res),"rows written")
