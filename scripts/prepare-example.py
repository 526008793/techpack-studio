"""Prepare the already-reviewed P4541 example from the working conversion data."""
import json
from pathlib import Path

root=Path(__file__).resolve().parents[1]
source=json.loads(Path('/tmp/p4541-randy/source-data.json').read_text())
materials=[]
for i,row in enumerate(source['materials']):
    if i==4:continue
    kind='fabric' if i<3 else 'graphic' if i==3 else 'trim' if i<10 else 'label'
    title=row[0].split(' / ',1)
    specs=row[1].split('\n')
    placement=row[6].replace('\n',' ').split(' / ',1)
    notes=row[7].split('\n') if row[7] else []
    if ' / ' in specs[0]:
        spec_zh,spec_en=specs[0].split(' / ',1)
        if len(specs)>1:spec_zh+='; '+'; '.join(specs[1:]);spec_en+='; '+'; '.join(specs[1:])
    elif len(specs)>1:spec_zh,spec_en=specs[0],specs[-1]
    else:spec_zh=spec_en=specs[0]
    if '\n' in row[6]:placement=row[6].split('\n',1)
    materials.append(dict(kind=kind,nameZh=title[0],nameEn=title[1] if len(title)>1 else title[0],specZh=spec_zh,specEn=spec_en,colors=[row[2]] if row[2] and '待确认' not in row[2] else [],quantity=row[4] if isinstance(row[4],(int,float)) else None,unitZh=row[5].split(' / ')[0] or None,unitEn=row[5].split(' / ')[-1] or None,placementZh=placement[0],placementEn=placement[-1],notesZh=notes[0] if notes else None,notesEn=notes[-1] if len(notes)>1 else None))
# The review example keeps exact original English specs and faithful Chinese.
materials[0].update(specZh='绒感单面针织；54%涤纶 / 39%粘胶 / 7%氨纶；348 GSM',specEn='PLUSH JERSEY KNIT; 54% POLY / 39% VISCOSE / 7% ELASTANE; 348 GSM')
for index in [1,2]:materials[index].update(specZh='CVC单面针织；60%棉 / 40%涤纶；160 GSM',specEn='CVC JERSEY; 60% COTTON / 40% POLYESTER; 160 GSM')
measurements=[dict(nameEn=en,nameZh=cn,value=v,tolerance=t,sourceValue=None,notes=None) for en,cn,v,t in source['measurements']]
construction=[]
for cn,en,detail in source['construction']:
    pieces=detail.split('\n',1)
    construction.append(dict(titleZh=cn,titleEn=en,detailZh=pieces[0],detailEn=pieces[1] if len(pieces)>1 else detail))
figures=[]
for role,page,box,caption in [
    ('appearance',1,(313,178,162,342),'款式彩色图'),
    ('construction',3,(20,130,748,420),'工艺图'),
    ('trimReference',5,(65,220,630,330),'抽绳和嵌条参考'),
    ('inspiration',6,(165,220,390,330),'款式参考照片'),
    ('labels',7,(20,130,748,420),'唛头参考图'),
]:
    x,y,w,h=box
    figures.append(dict(role=role,page=page,box=dict(x=x/792,y=y/612,width=w/792,height=h/612),captionZh=caption,captionEn=role))
data=dict(meta=dict(styleNumber='P4541',styleName='RANDY',descriptionZh='男式绒感针织束脚慢跑裤',descriptionEn='PLUSH JOGGER WITH CINCHED ANKLE',brand='UFC',customer='DEVELOPMENT',designer='ALEX',technical='MORGAN',reference='J4472 TOVA',season='FA27',sourceDate='2026-10-29',sampleSize='M',sizeScale=['S','M','L','XL','XXL'],unit='inch',factory=None,orderNumber=None,merchandiser=None,issueDate=None,dueDate=None,sampleQuantity=None),materials=materials,measurements=measurements,construction=construction,figures=figures,missingItems=['订单号、打样数量和交期未提供','洗水唛内容为占位，须按本款成分及测试结果确认','追踪唛参考图中的生产资料不可直接沿用','绣章尺寸及具体定位距离待确认'])
(root/'resources/example.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
print('Prepared reviewed example. Use scripts/generate-icon.py to rebuild icons.')
