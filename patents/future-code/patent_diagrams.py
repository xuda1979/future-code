from io import BytesIO
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

def diagram(number: int, font: Path) -> BytesIO:
    """Exact black and white flow figures; model images are not used."""
    sizes = {1: (1800, 680), 2: (1800, 780), 3: (1800, 1060)}
    canvas = Image.new('RGB', sizes[number], 'white')
    draw = ImageDraw.Draw(canvas)
    normal = ImageFont.truetype(str(font), 37)
    small = ImageFont.truetype(str(font), 31)

    def box(rect, label):
        draw.rectangle(rect, outline='black', width=3)
        lines = label.split('\n')
        center = ((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)
        for i, line in enumerate(lines):
            bounds = draw.textbbox((0, 0), line, font=normal)
            w, h = bounds[2] - bounds[0], bounds[3] - bounds[1]
            draw.text((center[0] - w / 2, center[1] + (i - (len(lines)-1)/2)*49 - h/2 - bounds[1]), line, font=normal, fill='black')

    def arrow(points, label=None, at=None):
        draw.line(points, fill='black', width=3, joint='curve')
        end, previous = points[-1], points[-2]
        dx, dy = end[0]-previous[0], end[1]-previous[1]
        length = (dx*dx+dy*dy)**.5
        ux, uy = dx/length, dy/length
        draw.polygon([end, (end[0]-16*ux+8*uy,end[1]-16*uy-8*ux), (end[0]-16*ux-8*uy,end[1]-16*uy+8*ux)], fill='black')
        if label:
            draw.text(at, label, font=small, fill='black')

    if number == 1:
        box((50,40,550,180), '模型结构化提议')
        box((650,40,1150,180), '宿主身份绑定\n与权限准入')
        box((1250,40,1750,180), '冻结契约与\n任务图及租约')
        arrow([(550,110),(650,110)])
        arrow([(1150,110),(1250,110)])
        box((1250,280,1750,420), '本地工具或\n远端作业协调')
        arrow([(1500,180),(1500,280)])
        box((650,280,1150,420), '工件及独立\n机器检查证据')
        arrow([(1250,350),(1150,350)])
        box((50,280,550,420), '完成门控与\n集成再验证')
        arrow([(650,350),(550,350)])
        box((50,520,550,650), '持久目标完成记录')
        arrow([(300,420),(300,520)])
    elif number == 2:
        box((480,30,1320,140), '提议与任务租约代际 f')
        box((480,210,1320,350), '核验契约 载荷 作用域\n及当前租约有效期')
        arrow([(900,140),(900,210)])
        box((40,430,770,570), '登记准入\n原子追加子任务')
        box((1050,430,1760,570), '拒绝或延期')
        arrow([(650,350),(650,390),(405,390),(405,430)], '有效', (430,351))
        arrow([(1150,350),(1150,390),(1405,390),(1405,430)], '无效', (1420,351))
        box((40,650,770,760), '实际操作前复核 f\n有效才执行和验证')
        box((1050,650,1760,760), '旧代际或过期\n拒绝宿主写入')
        arrow([(405,570),(405,650)])
        arrow([(770,705),(1050,705)], '失效', (847,655))
    else:
        box((420,25,1380,140), '事务中持久化意图\n稳定作业键及输入绑定')
        box((520,210,1280,310), '本地是否已有 job_id')
        arrow([(900,140),(900,210)])
        box((50,385,750,505), '幂等 ensure\n复用原 key')
        box((1050,385,1750,505), 'inspect\n使用已知 job_id')
        arrow([(600,310),(600,345),(400,345),(400,385)], '否', (380,310))
        arrow([(1200,310),(1200,345),(1400,345),(1400,385)], '是', (1430,310))
        box((520,590,1280,710), '核验响应身份和状态')
        arrow([(400,505),(400,550),(720,550),(720,590)])
        arrow([(1400,505),(1400,550),(1080,550),(1080,590)])
        box((60,810,740,940), '终态回执及检查证据\n进入目标完成门控')
        box((1060,810,1760,940), '未决或 UNKNOWN\n持久等待或人工协调')
        arrow([(650,710),(650,750),(400,750),(400,810)], '终态', (430,715))
        arrow([(1150,710),(1150,750),(1410,750),(1410,810)], '未确认', (1440,715))
        arrow([(1760,875),(1780,875),(1780,170),(1280,170),(1280,260)], '原身份重查', (1430,175))
        draw.text((65,980), '外部终态不等于目标验收通过；未决作业阻止目标完成', font=small, fill='black')
    output = BytesIO()
    canvas.save(output, format='PNG', dpi=(300,300))
    output.seek(0)
    return output
