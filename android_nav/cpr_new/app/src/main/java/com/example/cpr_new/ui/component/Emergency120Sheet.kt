package com.example.cpr_new.ui.component

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.cpr_new.core.contract.GeoSnapshot
import com.example.cpr_new.ui.CoachPalette
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun Emergency120Sheet(
    location: GeoSnapshot?,
    isSimulation: Boolean = true,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
    val lat = location?.latitude
    val lng = location?.longitude

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color(0xCC000000))
            .padding(20.dp),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            color = CoachPalette.CameraFrame,
            shape = RoundedCornerShape(24.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(18.dp)) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .border(1.dp, Color(0xFFEF4444), RoundedCornerShape(16.dp))
                        .padding(16.dp),
                ) {
                    Text(
                        text = "已发送 120 急救信息",
                        color = Color(0xFFEF4444),
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Black,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "位置：${lat?.let { "%.6f, %.6f".format(it, lng ?: 0.0) } ?: "未获取"}",
                        color = CoachPalette.TextSecondary,
                        fontSize = 13.sp,
                    )
                    Text(
                        text = "时间：$time",
                        color = CoachPalette.TextSecondary,
                        fontSize = 13.sp,
                    )
                }

                Spacer(Modifier.height(14.dp))
                Text("现场定位", color = CoachPalette.TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(10.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(120.dp)
                        .background(Color(0xFF1E293B), RoundedCornerShape(14.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        modifier = Modifier
                            .size(52.dp)
                            .background(Color.White.copy(alpha = 0.9f), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("▶", color = Color.Black, fontSize = 18.sp)
                    }
                }

                Spacer(Modifier.height(12.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    CoordCell("纬度", lat?.let { "%.6f".format(it) } ?: "--")
                    CoordCell("经度", lng?.let { "%.6f".format(it) } ?: "--")
                }
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    CoordCell("精度", location?.accuracyMeters?.let { "${it.toInt()} 米" } ?: "--")
                    CoordCell("时间", time)
                }

                if (isSimulation) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        text = "● 模拟演示，未真实拨号",
                        color = Color(0xFFFBBF24),
                        fontSize = 12.sp,
                    )
                }

                Spacer(Modifier.height(16.dp))
                Button(
                    onClick = onDismiss,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp),
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = CoachPalette.ActionStart,
                        contentColor = Color.Black,
                    ),
                ) {
                    Text("知道了", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun CoordCell(label: String, value: String) {
    Column(modifier = Modifier.padding(vertical = 4.dp)) {
        Text(label, color = CoachPalette.TextMuted, fontSize = 12.sp)
        Text(value, color = CoachPalette.TextSecondary, fontSize = 13.sp)
    }
}
