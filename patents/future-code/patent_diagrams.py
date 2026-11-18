"""Deterministic, monochrome figures for the 6G RAN patent disclosure."""
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def diagram(number: int, font: Path) -> BytesIO:
    sizes = {1: (1500, 760), 2: (1500, 835), 3: (1500, 990)}
    canvas = Image.new('RGB', sizes[number], 'white')
    draw = ImageDraw.Draw(canvas)
    font_index = 2 if font.name == 'NotoSansCJK-Regular.ttc' else 0
    normal = ImageFont.truetype(str(font), 44, index=font_index)
    small = ImageFont.truetype(str(font), 36, index=font_index)

    def box(rect, label):
        draw.rounded_rectangle(rect, radius=12, fill='#f5f5f5', outline='black', width=3)
        lines = label.split('\n')
        cx, cy = (rect[0] + rect[2])/2, (rect[1] + rect[3])/2
        for i, line in enumerate(lines):
            bounds = draw.textbbox((0, 0), line, font=normal)
            width = bounds[2] - bounds[0]
            if width > rect[2] - rect[0] - 20:
                raise ValueError(f'Figure {number}: label is too wide: {line}')
            y = cy + (i-(len(lines)-1)/2)*54
            draw.text((cx-width/2, y-(bounds[3]+bounds[1])/2), line, font=normal, fill='black')

    def arrow(points, label=None, at=None):
        draw.line(points, fill='black', width=3, joint='curve')
        end, previous = points[-1], points[-2]
        dx, dy = end[0]-previous[0], end[1]-previous[1]
        length = (dx*dx+dy*dy)**.5
        ux, uy = dx/length, dy/length
        draw.polygon([end, (end[0]-18*ux+9*uy, end[1]-18*uy-9*ux),
                      (end[0]-18*ux-9*uy, end[1]-18*uy+9*ux)], fill='black')
        if label:
            draw.text(at, label, font=small, fill='black')

    if number == 1:
        box((30,30,470,150), '业务意图\n与SLA')
        box((530,30,970,150), '能力目录与\n网络智能体')
        box((1030,30,1470,150), '无线动作\n协调器')
        arrow([(470,90),(530,90)])
        arrow([(970,90),(1030,90)])
        box((30,270,470,390), 'UE测量与\nRAN状态')
        arrow([(470,330),(500,330),(500,200),(1120,200),(1120,150)])
        box((1030,270,1470,390), '影响范围与\n联合评估')
        arrow([(1300,150),(1300,270)])
        box((530,270,970,390), '分区资源预留\n与执行凭证')
        arrow([(1030,330),(970,330)])
        box((530,510,970,630), '设备侧\n执行网关')
        arrow([(750,390),(750,510)])
        box((1030,510,1470,630), '6G基站与\n无线资源')
        arrow([(970,570),(1030,570)])
        box((30,510,470,630), '邻区和切片\n指标核验')
        arrow([(1250,630),(1250,710),(250,710),(250,630)])
        arrow([(250,510),(250,390)])
    elif number == 2:
        box((390,20,1110,130), '从无线耦合关系\n确定资源键和作用时段')
        box((390,184,1110,294), '按分区版本 r0\n评估候选及在途动作')
        box((390,348,1110,458), '比较 r0 并预留\n凭证绑定结果版本 r1')
        box((390,512,1110,622), '写入边界复核\n预留 版本 代际 状态')
        arrow([(750,130),(750,184)])
        arrow([(750,294),(750,348)])
        arrow([(750,458),(750,512)])
        box((20,725,650,815), '条件执行')
        box((850,725,1480,815), '拒绝并重新评估')
        arrow([(550,622),(550,680),(335,680),(335,725)], '条件有效', (175,625))
        arrow([(950,622),(950,680),(1165,680),(1165,725)], '条件失配', (1175,624))
        arrow([(1110,403),(1350,403),(1350,725)], 'r0 失配', (1150,346))
        arrow([(1480,769),(1490,769),(1490,240),(1110,240)])
    elif number == 3:
        box((420,20,1080,125), '持久动作标识及条件')
        box((420,175,1080,280), '设备侧条件执行')
        box((420,330,1080,435), '检查配置生效证据')
        arrow([(750,125),(750,175)])
        arrow([(750,280),(750,330)])
        box((20,520,660,640), '生效证据齐备\n按最晚生效时间观测')
        box((840,520,1480,640), '结果未知\n保留资源并查询原标识')
        arrow([(600,435),(600,470),(340,470),(340,520)], '齐备', (218,432))
        arrow([(900,435),(900,470),(1190,470),(1190,520)], '未知', (1095,410))
        arrow([(1480,573),(1490,573),(1490,382),(1080,382)])
        box((20,710,660,815), '核验邻区与切片指标')
        arrow([(340,640),(340,710)])
        box((840,710,1480,815), '确认终态后按\n当前状态评估补偿')
        arrow([(660,763),(840,763)])
        draw.text((694,710), '越界', font=small, fill='black')
        box((20,875,660,980), '验收通过\n结转在用资源')
        arrow([(340,815),(340,875)], '达标', (364,815))
    else:
        raise ValueError(number)
    output = BytesIO()
    canvas.save(output, format='PNG', dpi=(300,300))
    output.seek(0)
    return output
