package org.wavemesh.app

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The iOS app's look, drawn in Compose: an inset grouped list on the system's
// grouped background, white sections with rounded corners, tinted text for
// actions, petrol as the one accent (DESIGN.md, "Mobile Apps"). The colours are
// iOS's own system colours, light and dark, so the two apps read as one.

@Immutable
data class WaveColors(
    val background: Color,
    val section: Color,
    val label: Color,
    val secondary: Color,
    val separator: Color,
    val accent: Color,
    val orange: Color,
    val red: Color,
    val pressed: Color,
    val pill: Color,
)

private val Light = WaveColors(
    background = Color(0xFFF2F2F7),
    section = Color.White,
    label = Color.Black,
    secondary = Color(0x993C3C43),
    separator = Color(0x4A3C3C43),
    accent = Color(0xFF0F6E6E),
    orange = Color(0xFFFF9500),
    red = Color(0xFFFF3B30),
    pressed = Color(0xFFD1D1D6),
    pill = Color.White,
)

private val Dark = WaveColors(
    background = Color.Black,
    section = Color(0xFF1C1C1E),
    label = Color.White,
    secondary = Color(0x99EBEBF5),
    separator = Color(0x99545458),
    // A shade lighter on dark surfaces, as for the tray icon.
    accent = Color(0xFF0F7F7F),
    orange = Color(0xFFFF9F0A),
    red = Color(0xFFFF453A),
    pressed = Color(0xFF3A3A3C),
    pill = Color(0xFF2C2C2E),
)

val LocalWaveColors = staticCompositionLocalOf { Light }

/// The text styles of iOS's Dynamic Type at its default size.
object WaveType {
    val largeTitle = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.Bold, lineHeight = 41.sp)
    val title3 = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold, lineHeight = 25.sp)
    val headline = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp)
    val body = TextStyle(fontSize = 17.sp, lineHeight = 22.sp)
    val footnote = TextStyle(fontSize = 13.sp, lineHeight = 18.sp)
    val caption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp)
    val caption2 = TextStyle(fontSize = 11.sp, lineHeight = 13.sp)
}

@Composable
fun WaveTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colors = if (dark) Dark else Light
    // Material is still underneath -- text fields, dialogs, the cursor -- and
    // takes the same colours.
    val scheme = if (dark) {
        darkColorScheme(
            primary = colors.accent, onPrimary = Color.White,
            background = colors.background, surface = colors.section,
            surfaceContainerHigh = colors.section, onSurface = colors.label,
            onSurfaceVariant = colors.secondary, error = colors.red,
        )
    } else {
        lightColorScheme(
            primary = colors.accent, onPrimary = Color.White,
            background = colors.background, surface = colors.section,
            surfaceContainerHigh = colors.section, onSurface = colors.label,
            onSurfaceVariant = colors.secondary, error = colors.red,
        )
    }
    CompositionLocalProvider(LocalWaveColors provides colors) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

/// What a section is built from: rows, separated by a hairline as on iOS.
class SectionScope {
    val rows = mutableListOf<@Composable () -> Unit>()
    fun row(content: @Composable () -> Unit) {
        rows += content
    }
}

/// One section of an inset grouped list, with its header and footer.
@Composable
fun Section(
    header: String? = null,
    footer: String? = null,
    modifier: Modifier = Modifier,
    build: SectionScope.() -> Unit,
) {
    val colors = LocalWaveColors.current
    val rows = SectionScope().apply(build).rows
    if (rows.isEmpty() && header == null && footer == null) return
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        if (header != null) {
            Text(
                header,
                style = WaveType.headline,
                color = colors.secondary,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 8.dp),
            )
        } else {
            Spacer(Modifier.height(20.dp))
        }
        if (rows.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(SECTION_RADIUS))
                    .background(colors.section),
            ) {
                rows.forEachIndexed { index, row ->
                    if (index > 0) {
                        Box(
                            Modifier
                                .padding(start = 16.dp)
                                .fillMaxWidth()
                                .height(0.5.dp)
                                .background(colors.separator),
                        )
                    }
                    row()
                }
            }
        }
        if (footer != null) {
            Text(
                footer,
                style = WaveType.footnote,
                color = colors.secondary,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
            )
        }
    }
}

private val SECTION_RADIUS = 22.dp

/// A row's frame: iOS's 44-point minimum and its insets, with the system's
/// grey while pressed.
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ListRow(
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val clickable = if (onClick != null || onLongClick != null) {
        Modifier.combinedClickable(enabled = enabled, onClick = { onClick?.invoke() }, onLongClick = onLongClick)
    } else {
        Modifier
    }
    Row(
        Modifier
            .fillMaxWidth()
            .then(clickable)
            .heightIn(min = 48.dp)
            .padding(horizontal = 16.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}

/// An action in a list: tinted text, red when it destroys something.
@Composable
fun ButtonRow(
    text: String,
    icon: ImageVector? = null,
    destructive: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = LocalWaveColors.current
    val tint = when {
        !enabled -> colors.secondary
        destructive -> colors.red
        else -> colors.accent
    }
    ListRow(onClick = onClick, enabled = enabled) {
        if (icon != null) Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
        Text(text, style = WaveType.body, color = tint)
    }
}

/// A switch in a list, in petrol rather than the system's green: there is no
/// success green (DESIGN.md), and "on" is the one signal.
@Composable
fun ToggleRow(
    checked: Boolean,
    enabled: Boolean = true,
    onChange: (Boolean) -> Unit,
    label: @Composable () -> Unit,
) {
    val colors = LocalWaveColors.current
    ListRow {
        Box(Modifier.weight(1f)) { label() }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            enabled = enabled,
            colors = SwitchDefaults.colors(
                checkedTrackColor = colors.accent,
                checkedThumbColor = Color.White,
                checkedBorderColor = colors.accent,
                uncheckedThumbColor = Color.White,
                uncheckedTrackColor = colors.pressed,
                uncheckedBorderColor = colors.pressed,
            ),
        )
    }
}

/// A line with an icon in front, the way Label lays one out on iOS.
@Composable
fun LabelRow(
    icon: ImageVector,
    text: String,
    tint: Color,
    textColor: Color = LocalWaveColors.current.label,
    style: TextStyle = WaveType.body,
) {
    ListRow {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp).align(Alignment.Top))
        Text(text, style = style, color = textColor)
    }
}

/// The capsule a toolbar button sits in on iOS 26.
@Composable
fun PillButton(text: String, onClick: () -> Unit) {
    val colors = LocalWaveColors.current
    Box(
        Modifier
            .shadow(6.dp, RoundedCornerShape(50), ambientColor = Color(0x22000000), spotColor = Color(0x22000000))
            .clip(RoundedCornerShape(50))
            .background(colors.pill)
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 10.dp),
    ) {
        Text(text, style = WaveType.body, color = colors.label)
    }
}

/// The bar above a pushed page or a sheet: its title in the middle, actions
/// at either side -- iOS's inline navigation bar.
@Composable
fun InlineBar(
    title: String,
    leading: (@Composable RowScope.() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    val colors = LocalWaveColors.current
    Box(Modifier.fillMaxWidth().background(colors.background).padding(horizontal = 8.dp, vertical = 6.dp)) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically) {
            leading?.invoke(this)
        }
        Text(title, style = WaveType.headline, color = colors.label, modifier = Modifier.align(Alignment.Center))
        Row(Modifier.align(Alignment.CenterEnd), verticalAlignment = Alignment.CenterVertically) {
            trailing?.invoke(this)
        }
    }
}

/// A tinted word or icon in a bar.
@Composable
fun BarButton(
    text: String? = null,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    bold: Boolean = false,
    tint: Color? = null,
    onClick: () -> Unit,
) {
    val colors = LocalWaveColors.current
    val color = if (enabled) tint ?: colors.accent else colors.secondary
    Box(
        Modifier
            .clip(RoundedCornerShape(50))
            .clickable(enabled = enabled, onClick = onClick)
            .heightIn(min = 44.dp)
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        when {
            icon != null -> Icon(icon, contentDescription = text, tint = color, modifier = Modifier.size(24.dp))
            text != null -> Text(
                text,
                style = if (bold) WaveType.headline else WaveType.body,
                color = color,
            )
        }
    }
}

/// A small filled circle, the state dot in front of a peer.
@Composable
fun Dot(color: Color) {
    Box(Modifier.size(8.dp).clip(RoundedCornerShape(50)).background(color))
}
