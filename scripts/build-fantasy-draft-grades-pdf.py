from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "league-of-deadly-sins-2026-draft-grades.pdf"

NAVY = colors.HexColor("#101A2E")
INK = colors.HexColor("#182033")
SLATE = colors.HexColor("#536078")
MUTED = colors.HexColor("#7B879D")
PALE = colors.HexColor("#F3F6FA")
LINE = colors.HexColor("#DCE3EC")
BLUE = colors.HexColor("#1769E0")
CYAN = colors.HexColor("#2CB9D6")
GOLD = colors.HexColor("#F2B84B")
GREEN = colors.HexColor("#178A60")
RED = colors.HexColor("#D74A4A")
WHITE = colors.white


@dataclass(frozen=True)
class Team:
    rank: int
    name: str
    score: int
    grade: str
    core: str
    strength: str
    concern: str
    best_value: str
    worst_value: str
    next_move: str
    health: str


TEAMS = [
    Team(1, "Hubba bubba", 93, "A", "Jonathan Taylor / Drake London / Tee Higgins / Trey McBride / Jaylen Waddle", "The league's cleanest eight-man starter profile: elite RB1, four startable receivers and a premium tight end.", "Trevor Lawrence supplies less weekly separation than the elite quarterbacks, while the late RB depth is more quantity than certainty.", "Jakobi Meyers: +29", "Dylan Sampson: -50", "Preserve the receiver depth and use the first bench churn on a higher-upside RB.", "No major current flag among the projected starters."),
    Team(2, "Muggli's Mojo", 91, "A-", "Bijan Robinson / Rashee Rice / George Pickens / Tetairoa McMillan / Ladd McConkey", "Bijan plus one of the league's deepest receiver rooms gives this roster multiple two-FLEX combinations.", "Jacory Croskey-Merritt is the current market RB2 and Isaiah Likely is a thin standalone TE1.", "Christian Watson: +39", "Daniel Jones: -62", "Shop surplus WR or QB depth for a steadier RB2 or top-10 tight end.", "Monitor Croskey-Merritt's groin and Brian Thomas Jr.'s shoulder."),
    Team(3, "PWND", 90, "A-", "Ja'Marr Chase / A.J. Brown / Javonte Williams / D'Andre Swift / Bhayshul Tuten", "Two elite receivers and a balanced five-RB build create both floor and trade leverage.", "George Kittle's depressed price reflects Achilles recovery risk, and Brock Purdy is the only quarterback.", "Jayden Reed: +33", "George Kittle: -44", "Carry a Week 8 QB plan and be ready to stream TE if Kittle's workload is limited.", "Kittle recovery and Chase's knee practice status are the key watches."),
    Team(4, "The Warriors", 88, "B+", "Justin Jefferson / Derrick Henry / Zay Flowers / Cam Skattebo / Terry McLaurin", "Strong WR/FLEX construction, excellent late receiver value and enough RB volume to survive a two-FLEX format.", "The RB room is injury-heavy, and Alvin Kamara's MCL injury turns Round 12 into the draft's largest negative for this roster.", "Jerry Jeudy: +51", "Alvin Kamara: -45", "Move Kamara to IR when eligible, add a healthy RB, and identify a Week 7 QB streamer.", "Flowers, Skattebo, Hubbard, White and Kamara all require monitoring."),
    Team(5, "Lets go Brandon", 88, "B+", "De'Von Achane / Ashton Jeanty / Jeremiyah Love / Garrett Wilson / Joe Burrow", "Potentially dominant running-back ceiling, with three current top-30 half-PPR assets.", "Three quarterbacks consume scarce bench space, and the first three RBs all carry some current health uncertainty.", "Khalil Shakir: +22", "Tyjae Spears: -25", "Consolidate QB depth into a receiver upgrade after roles and health settle.", "Jeanty and Love are the main ankle-related checks."),
    Team(6, "Vlad the Impaler", 87, "B+", "Jahmyr Gibbs / Malik Nabers / Brock Bowers / Lamar Jackson / Davante Adams", "The most star-heavy spine in the league: elite players at RB, WR, TE and QB.", "Tony Pollard is the market RB2, Zach Charbonnet is on the PUP watch and the roster has several rehabilitation variables.", "Calvin Ridley: +25", "Juwan Johnson: -44", "Prioritize a healthy running back over carrying two quarterbacks once waivers open.", "Nabers and Charbonnet are material early-season health watches."),
    Team(7, "Madden Curse", 85, "B", "Puka Nacua / Nico Collins / Kyren Williams / DJ Moore / Bucky Irving", "Excellent top-six skill group with a high weekly ceiling at both WR and RB.", "The market has heavily discounted Sam LaPorta, and two quarterbacks reduce bench flexibility.", "DJ Moore: +21", "Sam LaPorta: -52", "Use the Herbert-Stroud surplus as trade leverage if a reliable TE upgrade appears.", "Monitor LaPorta's back history and Kyle Monangai's knee."),
    Team(8, "No Punt Intended", 84, "B", "Amon-Ra St. Brown / Josh Allen / Breece Hall / Travis Etienne Jr. / Rome Odunze", "Top-end QB and WR scoring plus four usable running backs make the weekly floor attractive.", "The WR2/FLEX group is less proven than the contender tier, and some middle-round selections came ahead of current ADP.", "Jaylen Warren: +19", "Rashid Shaheed: -35", "Target a dependable third receiver; consider moving one of the two tight ends if Tyler Warren starts fast.", "The projected core is relatively healthy entering Week 1."),
    Team(9, "Karate Chop", 83, "B", "Jaxon Smith-Njigba / Chase Brown / Josh Jacobs / Quinshon Judkins / David Montgomery", "The deepest top-four RB rotation in the league supports the two-FLEX format.", "Three quarterbacks and limited receiver depth create avoidable roster inefficiency; Travis Kelce is priced as a declining asset.", "Mike Evans: +25", "Travis Hunter: -81", "Trade or release QB3 and use the spot on a high-volume receiver.", "Jacobs and Jalen McMillan need continued injury monitoring."),
    Team(10, "Kyren on My Wayword Son", 81, "B-", "James Cook III / Omarion Hampton / Drake Maye / Jameson Williams / Rico Dowdle", "Strong starting RB duo and a high-upside quarterback provide a viable weekly base.", "The receiver room falls off quickly after Jameson Williams, while Tucker Kraft is returning from an ACL injury.", "Deebo Samuel Sr.: +27", "J.K. Dobbins: -47", "Make WR the first waiver priority and keep Dalton Kincaid active while Kraft ramps up.", "Kraft and Quentin Johnston are the immediate health checks."),
    Team(11, "Bazinga", 78, "C+", "CeeDee Lamb / Saquon Barkley / DeVonta Smith / Colston Loveland / Alec Pierce", "The first four rounds created a strong star core with top-tier WR and RB anchors.", "Quarterback and RB2 are unsettled, Tank Dell is not close to full readiness and several middle picks were well ahead of market.", "Xavier Worthy: +31", "Jaxson Dart: -64", "Use an IR slot on Dell and add a healthy RB before considering another receiver.", "Barkley, Dell and the QB situation carry the largest uncertainty."),
    Team(12, "Sacko Potatoes", 76, "C", "Christian McCaffrey / Kenneth Walker III / Chris Olave / Emeka Egbuka / DK Metcalf", "The starting skill core can still win weeks and contains legitimate top-20 upside.", "Two defenses and two kickers are expensive in a six-bench league, while TE and multiple receivers carry current injury questions.", "Josh Downs: +33", "T.J. Hockenson: -93", "Immediately convert the extra D/ST and kicker into healthy RB/WR upside.", "Egbuka, Downs, Hockenson and Keaton Mitchell need monitoring."),
]


WARRIORS_PICKS = [
    ("1.11", "Justin Jefferson", "WR", 14, -3, "B+"),
    ("2.02", "Derrick Henry", "RB", 10, 4, "A"),
    ("3.11", "Cam Skattebo", "RB", 42, -7, "B"),
    ("4.02", "Zay Flowers", "WR", 25, 13, "A"),
    ("5.11", "Terry McLaurin", "WR", 46, 13, "A"),
    ("6.02", "Jayden Daniels", "QB", 72, -10, "A-"),
    ("7.11", "Chuba Hubbard", "RB", 87, -4, "B"),
    ("8.02", "Kyle Pitts Sr.", "TE", 84, 2, "B"),
    ("9.11", "Rachaad White", "RB", 126, -19, "C+"),
    ("10.02", "Chris Godwin Jr.", "WR", 79, 31, "A"),
    ("11.11", "Dallas Goedert", "TE", 110, 21, "A"),
    ("12.02", "Alvin Kamara", "RB", 179, -45, "D"),
    ("13.11", "Rams D/ST", "D/ST", 117, 38, "A"),
    ("14.02", "Tank Bigsby", "RB", 169, -11, "B-"),
    ("15.11", "Harrison Butker", "K", 203, -24, "B-"),
    ("16.02", "Jerry Jeudy", "WR", 131, 51, "A+"),
]


SOURCES = [
    ("ESPN draft recap supplied by the user", "Local PDF created Aug. 27, 2026; all 192 selections verified."),
    ("ESPN private league settings", "12 teams; half-PPR; 1 QB, 2 RB, 2 WR, 1 TE, 2 FLEX, D/ST and K; 6 bench plus 2 IR."),
    ("Fantasy Football Calculator - 12-team half-PPR ADP", "3,144 mock drafts from Aug. 22-27, 2026; primary market-price benchmark."),
    ("Fantasy Football Calculator - half-PPR position rankings", "Updated Aug. 27, 2026; QB, WR, TE, D/ST and kicker context."),
    ("Rotoworld/NBC Sports Top 200", "Updated Aug. 26, 2026; independent overall-ranking cross-check."),
    ("PFN live injury tracker and official team reports", "Status cross-check through Aug. 27, 2026."),
]


def register_fonts() -> tuple[str, str, str]:
    candidates = [
        Path(r"C:\Windows\Fonts\arial.ttf"),
        Path(r"C:\Windows\Fonts\segoeui.ttf"),
    ]
    bold_candidates = [
        Path(r"C:\Windows\Fonts\arialbd.ttf"),
        Path(r"C:\Windows\Fonts\segoeuib.ttf"),
    ]
    italic_candidates = [
        Path(r"C:\Windows\Fonts\ariali.ttf"),
        Path(r"C:\Windows\Fonts\segoeuii.ttf"),
    ]
    regular = next((p for p in candidates if p.exists()), None)
    bold = next((p for p in bold_candidates if p.exists()), None)
    italic = next((p for p in italic_candidates if p.exists()), None)
    if regular and bold and italic:
        pdfmetrics.registerFont(TTFont("ReportSans", str(regular)))
        pdfmetrics.registerFont(TTFont("ReportSans-Bold", str(bold)))
        pdfmetrics.registerFont(TTFont("ReportSans-Italic", str(italic)))
        return "ReportSans", "ReportSans-Bold", "ReportSans-Italic"
    return "Helvetica", "Helvetica-Bold", "Helvetica-Oblique"


FONT, FONT_BOLD, FONT_ITALIC = register_fonts()


def P(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


styles = getSampleStyleSheet()
TITLE = ParagraphStyle("TitleX", fontName=FONT_BOLD, fontSize=24, leading=28, textColor=WHITE, spaceAfter=6)
SUBTITLE = ParagraphStyle("SubtitleX", fontName=FONT, fontSize=10.5, leading=14, textColor=colors.HexColor("#D9E5F5"))
H1 = ParagraphStyle("H1X", fontName=FONT_BOLD, fontSize=16, leading=20, textColor=NAVY, spaceBefore=2, spaceAfter=8)
H2 = ParagraphStyle("H2X", fontName=FONT_BOLD, fontSize=11.5, leading=14, textColor=BLUE, spaceBefore=4, spaceAfter=5)
BODY = ParagraphStyle("BodyX", fontName=FONT, fontSize=8.6, leading=11.8, textColor=INK, spaceAfter=4)
SMALL = ParagraphStyle("SmallX", fontName=FONT, fontSize=7.2, leading=9.3, textColor=SLATE)
TINY = ParagraphStyle("TinyX", fontName=FONT, fontSize=6.3, leading=8, textColor=SLATE)
LABEL = ParagraphStyle("LabelX", fontName=FONT_BOLD, fontSize=6.5, leading=8, textColor=MUTED, uppercase=True)
GRADE = ParagraphStyle("GradeX", fontName=FONT_BOLD, fontSize=24, leading=26, alignment=TA_CENTER, textColor=WHITE)
SCORE = ParagraphStyle("ScoreX", fontName=FONT_BOLD, fontSize=8, leading=9, alignment=TA_CENTER, textColor=WHITE)
CARD_NAME = ParagraphStyle("CardNameX", fontName=FONT_BOLD, fontSize=13, leading=15, textColor=NAVY)
CARD_TEXT = ParagraphStyle("CardTextX", fontName=FONT, fontSize=7.6, leading=10.2, textColor=INK)
CARD_LABEL = ParagraphStyle("CardLabelX", fontName=FONT_BOLD, fontSize=6.4, leading=8, textColor=BLUE)
WHITE_SMALL = ParagraphStyle("WhiteSmallX", fontName=FONT, fontSize=7.5, leading=10, textColor=WHITE)
FOOT = ParagraphStyle("FootX", fontName=FONT, fontSize=6.2, leading=8, textColor=MUTED)


def grade_color(grade: str) -> colors.Color:
    if grade.startswith("A"):
        return GREEN
    if grade.startswith("B"):
        return BLUE
    if grade.startswith("C"):
        return GOLD
    return RED


def header_footer(canvas, doc):
    canvas.saveState()
    page = canvas.getPageNumber()
    if page > 1:
        canvas.setFillColor(NAVY)
        canvas.rect(0, letter[1] - 0.34 * inch, letter[0], 0.34 * inch, stroke=0, fill=1)
        canvas.setFont(FONT_BOLD, 7.2)
        canvas.setFillColor(WHITE)
        canvas.drawString(0.48 * inch, letter[1] - 0.22 * inch, "THE LEAGUE OF DEADLY SINS - 2026 DRAFT GRADES")
        canvas.setFillColor(CYAN)
        canvas.circle(letter[0] - 0.54 * inch, letter[1] - 0.17 * inch, 2.3, stroke=0, fill=1)
    canvas.setStrokeColor(LINE)
    canvas.line(0.48 * inch, 0.38 * inch, letter[0] - 0.48 * inch, 0.38 * inch)
    canvas.setFont(FONT, 6.4)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.48 * inch, 0.22 * inch, "Preseason market-based analysis - data lock Aug. 27, 2026")
    canvas.drawRightString(letter[0] - 0.48 * inch, 0.22 * inch, f"Page {page}")
    canvas.restoreState()


class ReportDocTemplate(BaseDocTemplate):
    def __init__(self, filename: str):
        super().__init__(
            filename,
            pagesize=letter,
            leftMargin=0.48 * inch,
            rightMargin=0.48 * inch,
            topMargin=0.48 * inch,
            bottomMargin=0.48 * inch,
            title="The League of Deadly Sins - 2026 Fantasy Football Draft Grades",
            author="OpenAI Codex",
            subject="League-wide fantasy football draft grades",
        )
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="main")
        self.addPageTemplates([PageTemplate(id="report", frames=frame, onPage=header_footer)])


def score_bar(score: int, width: float = 1.25 * inch) -> Table:
    filled = width * score / 100
    remainder = width - filled
    data = [["", ""]]
    table = Table(data, colWidths=[filled, remainder], rowHeights=[5])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), BLUE),
        ("BACKGROUND", (1, 0), (1, 0), colors.HexColor("#E6EBF2")),
        ("BOX", (0, 0), (-1, -1), 0, WHITE),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return table


def ranking_table() -> Table:
    rows = [[P("RK", LABEL), P("TEAM", LABEL), P("GRADE", LABEL), P("SCORE", LABEL), P("POWER", LABEL)]]
    for t in TEAMS:
        rows.append([
            P(str(t.rank), BODY),
            P(t.name, BODY if t.name != "The Warriors" else ParagraphStyle("Warriors", parent=BODY, fontName=FONT_BOLD, textColor=BLUE)),
            P(t.grade, ParagraphStyle("G", parent=BODY, fontName=FONT_BOLD, textColor=grade_color(t.grade), alignment=TA_CENTER)),
            P(str(t.score), ParagraphStyle("S", parent=BODY, alignment=TA_CENTER)),
            score_bar(t.score),
        ])
    table = Table(rows, colWidths=[0.34 * inch, 2.25 * inch, 0.55 * inch, 0.48 * inch, 1.45 * inch], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("ALIGN", (2, 1), (3, -1), "CENTER"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PALE]),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def team_card(t: Team) -> Table:
    badge = Table([[P(t.grade, GRADE)], [P(f"{t.score}/100", SCORE)]], colWidths=[0.74 * inch], rowHeights=[0.43 * inch, 0.22 * inch])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), grade_color(t.grade)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 1),
        ("RIGHTPADDING", (0, 0), (-1, -1), 1),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    title = Table([
        [P(f"#{t.rank}  {t.name}", CARD_NAME)],
        [P(f"CORE: {t.core}", CARD_LABEL)],
    ], colWidths=[5.9 * inch])
    upper = Table([[badge, title]], colWidths=[0.8 * inch, 6.0 * inch])
    upper.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    body = Table([
        [P("WHY IT WORKS", CARD_LABEL), P("PRIMARY RISK", CARD_LABEL)],
        [P(t.strength, CARD_TEXT), P(t.concern, CARD_TEXT)],
        [P("MARKET VALUE", CARD_LABEL), P("NEXT MOVE", CARD_LABEL)],
        [P(f"Best: {t.best_value}<br/>Largest reach: {t.worst_value}", CARD_TEXT), P(t.next_move, CARD_TEXT)],
        [P("HEALTH WATCH", CARD_LABEL), ""],
        [P(t.health, CARD_TEXT), ""],
    ], colWidths=[3.38 * inch, 3.38 * inch])
    body.setStyle(TableStyle([
        ("SPAN", (0, 4), (1, 4)),
        ("SPAN", (0, 5), (1, 5)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.45, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, LINE),
        ("BACKGROUND", (0, 0), (-1, 0), PALE),
        ("BACKGROUND", (0, 2), (-1, 2), PALE),
        ("BACKGROUND", (0, 4), (-1, 4), PALE),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    card = Table([[upper], [body]], colWidths=[6.9 * inch])
    card.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#C8D2E0")),
        ("BACKGROUND", (0, 0), (-1, 0), WHITE),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return card


def warriors_pick_table() -> Table:
    rows = [[P(x, LABEL) for x in ["PICK", "PLAYER", "POS", "ADP", "VALUE", "GRADE"]]]
    for pick, player, pos, adp, gap, grade in WARRIORS_PICKS:
        gap_color = GREEN if gap > 0 else RED if gap < 0 else SLATE
        rows.append([
            P(pick, SMALL), P(player, SMALL), P(pos, SMALL), P(str(adp), SMALL),
            P(f"{gap:+d}", ParagraphStyle("Gap", parent=SMALL, textColor=gap_color, alignment=TA_CENTER)),
            P(grade, ParagraphStyle("PG", parent=SMALL, fontName=FONT_BOLD, textColor=grade_color(grade), alignment=TA_CENTER)),
        ])
    table = Table(rows, colWidths=[0.55 * inch, 2.1 * inch, 0.48 * inch, 0.5 * inch, 0.58 * inch, 0.6 * inch], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PALE]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("ALIGN", (2, 0), (-1, -1), "CENTER"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return table


def build_story():
    story = []

    hero = Table([
        [P("2026 DRAFT GRADES", TITLE)],
        [P("The League of Deadly Sins", ParagraphStyle("League", parent=TITLE, fontSize=15, leading=18, textColor=GOLD))],
        [P("All 12 teams ranked and graded using the confirmed ESPN format, current half-PPR ADP, updated rankings and late-August injury information.", SUBTITLE)],
        [Spacer(1, 5)],
        [P("DATA LOCK  AUGUST 27, 2026", ParagraphStyle("Lock", parent=WHITE_SMALL, fontName=FONT_BOLD, textColor=CYAN))],
    ], colWidths=[7.0 * inch])
    hero.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), NAVY),
        ("LEFTPADDING", (0, 0), (-1, -1), 18),
        ("RIGHTPADDING", (0, 0), (-1, -1), 18),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story += [hero, Spacer(1, 10)]

    settings = Table([
        [P("12 TEAMS", LABEL), P("0.5 PPR", LABEL), P("2 FLEX", LABEL), P("6 BENCH + 2 IR", LABEL)],
        [P("Snake draft", BODY), P("Head-to-head points", BODY), P("8 offensive starters", BODY), P("Active management matters", BODY)],
    ], colWidths=[1.72 * inch] * 4)
    settings.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EAF1FB")),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [settings, Spacer(1, 10), P("League power board", H1), ranking_table(), Spacer(1, 8)]
    callout = Table([[P("THE SHORT VERSION", LABEL), P("Hubba bubba owns the cleanest healthy starting lineup. Muggli's Mojo and PWND are close behind. The Warriors have contender-level depth but receive a B+ because five RB/WR assets carry meaningful health uncertainty. Sacko Potatoes has enough stars to recover, but the extra defense and kicker are costly in this shallow-bench format.", BODY)]], colWidths=[1.18 * inch, 5.68 * inch])
    callout.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFF6DD")),
        ("BOX", (0, 0), (-1, -1), 0.7, GOLD),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story += [callout, PageBreak()]

    story += [P("How the grades work", H1)]
    methodology = [
        ("Current roster strength", "Starter quality for 1 QB, 2 RB, 2 WR, 1 TE and two FLEX slots, using current 12-team half-PPR market price and ranking tiers."),
        ("Depth and construction", "Best four bench skill players, position balance, and whether scarce bench spots were spent on redundant quarterbacks, tight ends, defenses or kickers."),
        ("Draft execution", "Selection number versus current ADP. Positive value means the player was selected later than current ADP; negative value means the player was drafted ahead of market."),
        ("Health and role risk", "Confirmed injury news, rehabilitation status and unresolved depth-chart roles through Aug. 27. ADP already reflects some injury risk, so this is a calibration rather than a second full penalty."),
    ]
    rows = []
    for title, body in methodology:
        rows.append([P(title.upper(), CARD_LABEL), P(body, BODY)])
    mt = Table(rows, colWidths=[1.55 * inch, 5.25 * inch])
    mt.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, LINE),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [WHITE, PALE]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story += [mt, Spacer(1, 11), P("League-wide findings", H1)]
    findings = [
        "Two FLEX spots reward deep WR/RB rooms. Hubba bubba, Muggli's Mojo, PWND and The Warriors are best positioned to fill eight offensive starts without waiver help.",
        "Quarterback was drafted aggressively. Four teams carry at least two quarterbacks, and two carry three; in a one-QB league, that is potential trade inventory or replaceable bench cost.",
        "This league's D/ST scoring is unusually volatile: sacks are worth 2, blocks 5, safeties 10 and a shutout 15. A top defense matters more here than in defaults, but carrying two still costs valuable depth.",
        "Kicker misses are punitive (-5 inside 40 yards and -3 from 40-49). Accuracy and job security matter more than brand name.",
        "The current injury cluster is concentrated at RB and WR, making the two IR slots and early waiver claims unusually important.",
    ]
    for item in findings:
        story.append(P(f"<font color='#1769E0'>●</font>  {item}", BODY))
    story += [Spacer(1, 8), P("Important interpretation", H2), P("These are preseason draft grades, not guarantees of final standings. The score combines market-based roster strength, current injury/role information and construction for this exact league. Waivers, trades and lineup choices will quickly matter more than the original draft grade.", BODY), Spacer(1, 8)]
    correction = Table([[P("CALCULATION CORRECTION", CARD_LABEL), P("The earlier single-team response described The Warriors as roughly +200 picks of market value. After applying one consistent convention across all 192 selections, the correct net is approximately +50 picks. The B+ letter grade is unchanged; this report uses the corrected figure throughout.", BODY)]], colWidths=[1.45 * inch, 5.35 * inch])
    correction.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFF0EF")),
        ("BOX", (0, 0), (-1, -1), 0.7, RED),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story += [correction, PageBreak()]

    for i in range(0, len(TEAMS), 2):
        story += [P(f"Team reports  {i + 1}-{min(i + 2, len(TEAMS))} of 12", H1), team_card(TEAMS[i]), Spacer(1, 11), team_card(TEAMS[i + 1])]
        if i + 2 < len(TEAMS):
            story.append(PageBreak())

    story += [PageBreak(), P("The Warriors - detailed draft sheet", H1)]
    overview = Table([
        [P("GRADE", LABEL), P("POWER RANK", LABEL), P("NET ADP VALUE", LABEL), P("PLAYOFF PROFILE", LABEL)],
        [P("B+ (88)", ParagraphStyle("OV1", parent=BODY, fontName=FONT_BOLD, textColor=BLUE, alignment=TA_CENTER)), P("4 of 12", ParagraphStyle("OV2", parent=BODY, alignment=TA_CENTER)), P("+50 picks", ParagraphStyle("OV3", parent=BODY, fontName=FONT_BOLD, textColor=GREEN, alignment=TA_CENTER)), P("Above-average contender", ParagraphStyle("OV4", parent=BODY, alignment=TA_CENTER))],
    ], colWidths=[1.15 * inch, 1.15 * inch, 1.35 * inch, 2.2 * inch])
    overview.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story += [overview, Spacer(1, 8)]
    layout = Table([
        [P("PROJECTED OPENING LINEUP", CARD_LABEL), P("KEY BENCH", CARD_LABEL)],
        [P("QB Jayden Daniels<br/>RB Derrick Henry<br/>RB Cam Skattebo<br/>WR Justin Jefferson<br/>WR Zay Flowers<br/>TE Kyle Pitts Sr.<br/>FLEX Terry McLaurin<br/>FLEX Chris Godwin Jr.<br/>D/ST Rams<br/>K Harrison Butker", BODY), P("Chuba Hubbard<br/>Rachaad White<br/>Jerry Jeudy<br/>Dallas Goedert<br/>Alvin Kamara (IR candidate)<br/>Tank Bigsby", BODY)],
    ], colWidths=[3.3 * inch, 3.3 * inch])
    layout.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PALE),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [layout, Spacer(1, 9), P("Round-by-round value", H2), P("Value = overall selection number minus current ADP. Positive means the player fell past market price; negative means the player was taken earlier than current market. Custom scoring improves Daniels and Rams D/ST beyond generic ADP.", SMALL), Spacer(1, 5), warriors_pick_table(), Spacer(1, 8)]
    priorities = Table([
        [P("1", ParagraphStyle("N1", parent=GRADE, fontSize=16, leading=18)), P("Use IR and add a healthy RB", CARD_NAME), P("Kamara is expected to miss at least a month with an MCL sprain. If ESPN grants IR eligibility, use the open slot immediately.", CARD_TEXT)],
        [P("2", ParagraphStyle("N2", parent=GRADE, fontSize=16, leading=18)), P("Plan for Week 7", CARD_NAME), P("Daniels, McLaurin and White share a Week 7 bye. Identify the quarterback stream before the waiver market tightens.", CARD_TEXT)],
        [P("3", ParagraphStyle("N3", parent=GRADE, fontSize=16, leading=18)), P("Keep Jeudy", CARD_NAME), P("Jerry Jeudy was the roster's best pure value and supplies two-FLEX insulation while Flowers and the RB room are monitored.", CARD_TEXT)],
    ], colWidths=[0.42 * inch, 1.85 * inch, 4.35 * inch])
    priorities.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), BLUE),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [P("Immediate priorities", H2), priorities, PageBreak()]

    story += [P("Health watch and source sheet", H1)]
    health_rows = [
        ("Alvin Kamara", "High", "Sprained MCL; expected out at least one month and may miss multiple regular-season games.", "The Warriors"),
        ("Zach Charbonnet", "High", "PUP/knee watch; early-season availability remains uncertain.", "Vlad the Impaler"),
        ("Tank Dell", "High", "Still not close to game readiness in the latest reports.", "Bazinga"),
        ("Malik Nabers", "Medium", "Returning from a major knee injury; workload and Week 1 readiness remain important.", "Vlad the Impaler"),
        ("Zay Flowers", "Medium", "Missed consecutive practices with an undisclosed issue.", "The Warriors"),
        ("Chuba Hubbard", "Medium", "Hamstring injury; team expects Week 1, but soft-tissue recurrence risk remains.", "The Warriors"),
        ("Rachaad White", "Medium", "Hamstring; recently limited to individual drills and expected to split work.", "The Warriors"),
        ("Emeka Egbuka", "Medium", "Toe issue and recent missed practices.", "Sacko Potatoes"),
        ("Josh Downs", "Medium", "Calf injury and recent missed practice.", "Sacko Potatoes"),
        ("Tucker Kraft", "Medium", "Returning from ACL surgery; early workload needs confirmation.", "Kyren on My Wayword Son"),
    ]
    hr = [[P("PLAYER", LABEL), P("RISK", LABEL), P("CURRENT NOTE", LABEL), P("TEAM", LABEL)]]
    for player, risk, note, team in health_rows:
        c = RED if risk == "High" else GOLD
        hr.append([P(player, SMALL), P(risk, ParagraphStyle("Risk", parent=SMALL, fontName=FONT_BOLD, textColor=c)), P(note, SMALL), P(team, SMALL)])
    ht = Table(hr, colWidths=[1.2 * inch, 0.58 * inch, 3.45 * inch, 1.55 * inch], repeatRows=1)
    ht.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.35, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PALE]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story += [ht, Spacer(1, 10), P("Confirmed sources", H1)]
    for name, note in SOURCES:
        story.append(P(f"<b>{name}</b><br/>{note}", BODY))
    source_links = [
        ("Fantasy Football Calculator ADP", "https://fantasyfootballcalculator.com/adp/half-ppr"),
        ("Fantasy Football Calculator half-PPR rankings", "https://fantasyfootballcalculator.com/rankings/half-ppr"),
        ("FantasyPros half-PPR rankings", "https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php"),
        ("Rotoworld/NBC Sports Top 200", "https://www.nbcsports.com/fantasy/football/news/2026-fantasy-football-top-200-overall-rankings"),
        ("PFN injury tracker", "https://www.profootballnetwork.com/fantasy-hq/injury-report"),
        ("Panthers: Chuba Hubbard update", "https://www.panthers.com/news/chuba-hubbard-s-close-to-coming-back-and-continuing-to-bring-others-along-with-him"),
        ("Buccaneers: Chris Godwin camp update", "https://www.buccaneers.com/news/training-camp-takeaways-practice-day-10-2026"),
        ("Giants: Cam Skattebo return update", "https://www.giants.com/news/quotes-8-17-john-harbaugh-malik-nabers-cam-skattebo"),
        ("FantasyPros: Alvin Kamara MCL update", "https://www.fantasypros.com/nfl/news/603242/alvin-kamara-knee-sidelined-month-with-sprained-mcl.php"),
    ]
    link_rows = []
    for i in range(0, len(source_links), 2):
        cells = []
        for name, url in source_links[i:i+2]:
            cells.append(P(f"<link href='{url}' color='#1769E0'>{name}</link>", SMALL))
        if len(cells) == 1:
            cells.append("")
        link_rows.append(cells)
    lt = Table(link_rows, colWidths=[3.35 * inch, 3.35 * inch])
    lt.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.45, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story += [lt, Spacer(1, 10), P("Scope note", H2), P("All rankings, injuries and team situations are snapshots as of the stated data lock and can change quickly. No roster moves, waiver claims, trades or league-setting changes were made while preparing this report.", BODY)]
    return story


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = ReportDocTemplate(str(OUTPUT))
    doc.build(build_story())
    print(OUTPUT)


if __name__ == "__main__":
    main()
