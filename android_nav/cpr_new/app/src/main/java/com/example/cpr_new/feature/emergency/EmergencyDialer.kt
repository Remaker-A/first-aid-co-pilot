package com.example.cpr_new.feature.emergency

import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * 急救拨号器 —— 流程集成。
 *
 * 设计要点：
 * - 默认使用 [Intent.ACTION_DIAL]（仅在拨号盘预填号码，由用户确认拨出），
 *   这样**无需 CALL_PHONE 权限**，更安全，也避免 Demo 误拨真实急救电话；
 * - 若产品确需一键直拨，可切换到 ACTION_CALL（需额外权限），此处保留扩展位。
 *
 * 急救号码可配置，默认中国大陆 120。
 */
class EmergencyDialer(private val context: Context) {

    /**
     * 打开拨号盘并预填急救号码。
     * @return 是否成功唤起拨号界面。
     */
    fun dial(number: String = DEFAULT_EMERGENCY_NUMBER): Boolean = runCatching {
        val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$number")).apply {
            // 从非 Activity 上下文启动需要该 flag。
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.applicationContext.startActivity(intent)
        true
    }.getOrDefault(false)

    companion object {
        const val DEFAULT_EMERGENCY_NUMBER = "120"
    }
}
