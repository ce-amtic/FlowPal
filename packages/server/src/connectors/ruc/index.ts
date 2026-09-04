import type { NewFragment } from '../../store/fragments.ts'

/**
 * 人大教务系统接入。
 *
 * 课表、考试安排、校历都是「时间轴上的外部压力」这个画像维度的直接输入。
 * 输出统一成 raw_type='structured' 的碎片，下游一视同仁——
 * 结构化碎片走 pipeline/map-structured.ts，不经模型。
 *
 * 凭据从 config.local.json 读，该文件在 .gitignore 里。
 *
 * 演示不依赖现场登录：课表提前导好躺在库里，路演时不发生一次教务系统往返。
 * 现场网好的话再当场跑一次当加分项。
 *
 * 验收依据：同一个学号拉回来的课表行，与既有的 Flutter/Dart 实现逐行对齐。
 *
 * 待实现：照搬既有实现的登录鉴权与接口调用。
 */
export type RucCredentials = { studentId: string; password: string }

export type RucSession = { cookie: string }

export async function login(_credentials: RucCredentials): Promise<RucSession> {
  throw new Error('教务系统登录还没实现')
}

export async function fetchTimetable(_session: RucSession, _termId: string): Promise<NewFragment[]> {
  throw new Error('课表拉取还没实现')
}

export async function fetchExams(_session: RucSession, _termId: string): Promise<NewFragment[]> {
  throw new Error('考试安排拉取还没实现')
}

export async function fetchCalendar(_session: RucSession): Promise<NewFragment[]> {
  throw new Error('校历拉取还没实现')
}
