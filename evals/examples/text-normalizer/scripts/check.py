import csv,json,sys
from pathlib import Path
rows=list(csv.DictReader((Path(sys.argv[2])/"result.csv").open()))
ok=rows==[{"name":"ALICE","amount":"3"},{"name":"BOB","amount":"2"}]
print(json.dumps({"checks":[{"name":"记录、数值及排序一致","status":"pass" if ok else "fail","critical":True,"evidence":str(rows),"file":"result.csv"}]}))
