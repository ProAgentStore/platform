package online.proagentstore.app

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.ViewKanban
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            PagsTheme {
                val context = LocalContext.current
                val model: PagsViewModel = viewModel(factory = PagsViewModel.factory(context.applicationContext))
                PagsApp(model)
            }
        }
    }
}

private enum class Tab(val title: String, val icon: ImageVector) {
    Agents("Agents", Icons.Filled.Dashboard),
    Chat("Chat", Icons.Filled.Chat),
    Board("Board", Icons.Filled.ViewKanban),
    Coder("Coder", Icons.Filled.Code),
    Settings("Settings", Icons.Filled.Settings),
}

data class User(val login: String, val displayName: String)
data class AgentInstance(val id: String, val name: String, val agentName: String, val status: String)
data class ChatMessage(val role: String, val content: String)
data class BoardTask(val title: String, val status: String, val summary: String)

data class PagsState(
    val token: String = "",
    val user: User? = null,
    val instances: List<AgentInstance> = emptyList(),
    val selectedId: String? = null,
    val messages: List<ChatMessage> = emptyList(),
    val tasks: List<BoardTask> = emptyList(),
    val instructions: String = "",
    val loading: Boolean = false,
    val error: String? = null,
) {
    val signedIn: Boolean get() = token.isNotBlank()
    val selected: AgentInstance? get() = instances.firstOrNull { it.id == selectedId } ?: instances.firstOrNull()
}

class PagsViewModel(private val context: Context) : ViewModel() {
    private val prefs = context.getSharedPreferences("pags", Context.MODE_PRIVATE)
    private val api = PagsApi()
    private val _state = MutableStateFlow(PagsState(token = prefs.getString("token", "") ?: ""))
    val state: StateFlow<PagsState> = _state.asStateFlow()

    init {
        if (_state.value.signedIn) refresh()
    }

    fun signIn(token: String) {
        prefs.edit().putString("token", token.trim()).apply()
        _state.value = _state.value.copy(token = token.trim(), error = null)
        refresh()
    }

    fun signOut() {
        prefs.edit().remove("token").apply()
        _state.value = PagsState()
    }

    fun select(instanceId: String) {
        _state.value = _state.value.copy(selectedId = instanceId, messages = emptyList(), tasks = emptyList())
        refreshInstance()
    }

    fun updateInstructions(value: String) {
        _state.value = _state.value.copy(instructions = value)
    }

    fun refresh() {
        val token = _state.value.token
        if (token.isBlank()) return
        viewModelScope.launch {
            setLoading(true)
            runCatching {
                val user = api.me(token)
                val instances = api.instances(token)
                _state.value = _state.value.copy(
                    user = user,
                    instances = instances,
                    selectedId = _state.value.selectedId ?: instances.firstOrNull()?.id,
                    error = null,
                )
                refreshInstance()
            }.onFailure { fail(it) }
            setLoading(false)
        }
    }

    fun refreshInstance() {
        val token = _state.value.token
        val instanceId = _state.value.selected?.id ?: return
        viewModelScope.launch {
            runCatching {
                val messages = api.messages(token, instanceId)
                val tasks = api.tasks(token, instanceId)
                _state.value = _state.value.copy(messages = messages, tasks = tasks, error = null)
            }.onFailure { fail(it) }
        }
    }

    fun send(message: String) {
        val token = _state.value.token
        val instanceId = _state.value.selected?.id ?: return
        if (message.isBlank()) return
        _state.value = _state.value.copy(messages = _state.value.messages + ChatMessage("user", message))
        viewModelScope.launch {
            setLoading(true)
            runCatching {
                val reply = api.chat(token, instanceId, message)
                _state.value = _state.value.copy(messages = _state.value.messages + reply, error = null)
            }.onFailure { fail(it) }
            setLoading(false)
        }
    }

    fun saveInstructions() {
        val token = _state.value.token
        val instanceId = _state.value.selected?.id ?: return
        viewModelScope.launch {
            setLoading(true)
            runCatching {
                api.saveInstructions(token, instanceId, _state.value.instructions)
                _state.value = _state.value.copy(error = null)
            }.onFailure { fail(it) }
            setLoading(false)
        }
    }

    private fun setLoading(value: Boolean) {
        _state.value = _state.value.copy(loading = value)
    }

    private fun fail(error: Throwable) {
        _state.value = _state.value.copy(error = error.message ?: "Request failed")
    }

    companion object {
        fun factory(context: Context) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = PagsViewModel(context) as T
        }
    }
}

private class PagsApi {
    private val client = OkHttpClient()
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val base = "https://api.proagentstore.online"

    suspend fun me(token: String): User = withContext(Dispatchers.IO) {
        val json = get(token, "/v1/auth/me")
        User(
            login = json.optString("login", "user"),
            displayName = json.optString("display_name", json.optString("login", "ProAgentStore user")),
        )
    }

    suspend fun instances(token: String): List<AgentInstance> = withContext(Dispatchers.IO) {
        val json = get(token, "/v1/instances/my/instances")
        val array = json.optJSONArray("instances") ?: JSONArray()
        List(array.length()) { index ->
            val item = array.getJSONObject(index)
            val agent = item.optJSONObject("agent")
            AgentInstance(
                id = item.optString("id"),
                name = item.optString("name", agent?.optString("name").orEmpty()).ifBlank { "Agent instance" },
                agentName = agent?.optString("name").orEmpty().ifBlank { item.optString("agent_name", "Agent") },
                status = item.optString("status", "ready"),
            )
        }
    }

    suspend fun messages(token: String, instanceId: String): List<ChatMessage> = withContext(Dispatchers.IO) {
        val json = get(token, "/v1/instances/$instanceId/messages")
        val array = json.optJSONArray("messages") ?: JSONArray()
        List(array.length()) { index ->
            val item = array.getJSONObject(index)
            ChatMessage(
                role = item.optString("role", "assistant"),
                content = item.optString("content", item.optString("message", "")),
            )
        }
    }

    suspend fun tasks(token: String, instanceId: String): List<BoardTask> = withContext(Dispatchers.IO) {
        val paths = listOf("/v1/instances/$instanceId/tasks", "/v1/instances/$instanceId/task-events")
        val json = paths.firstNotNullOfOrNull { path -> runCatching { get(token, path) }.getOrNull() } ?: JSONObject()
        val array = json.optJSONArray("tasks") ?: json.optJSONArray("events") ?: JSONArray()
        List(array.length()) { index ->
            val item = array.getJSONObject(index)
            BoardTask(
                title = item.optString("title", item.optString("type", "Task")),
                status = item.optString("status", item.optString("state", "open")),
                summary = item.optString("summary", item.optString("message", "")),
            )
        }
    }

    suspend fun chat(token: String, instanceId: String, message: String): ChatMessage = withContext(Dispatchers.IO) {
        val json = post(token, "/v1/instances/$instanceId/chat", JSONObject().put("message", message))
        ChatMessage("assistant", json.optString("message", json.optString("content", json.toString())))
    }

    suspend fun saveInstructions(token: String, instanceId: String, instructions: String) = withContext(Dispatchers.IO) {
        post(token, "/v1/instances/$instanceId/instructions", JSONObject().put("instructions", instructions))
        Unit
    }

    private fun get(token: String, path: String): JSONObject = request(token, path, "GET", null)

    private fun post(token: String, path: String, body: JSONObject): JSONObject =
        request(token, path, "POST", body.toString().toRequestBody(jsonType))

    private fun request(token: String, path: String, method: String, body: okhttp3.RequestBody?): JSONObject {
        val request = Request.Builder()
            .url("$base$path")
            .method(method, body)
            .addHeader("Accept", "application/json")
            .addHeader("Authorization", "Bearer $token")
            .apply { if (body != null) addHeader("Content-Type", "application/json") }
            .build()
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IllegalStateException(JSONObject(text.ifBlank { "{}" }).optString("error", "HTTP ${response.code}"))
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }
}

@Composable
fun PagsApp(model: PagsViewModel) {
    val state by model.state.collectAsState()
    var tab by remember { mutableStateOf(Tab.Agents) }
    LaunchedEffect(state.signedIn) {
        if (!state.signedIn) tab = Tab.Agents
    }

    if (!state.signedIn) {
        SignInScreen(state, model::signIn)
        return
    }

    Scaffold(
        topBar = { PagsTopBar(state, model::refresh) },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { item ->
                    NavigationBarItem(
                        selected = tab == item,
                        onClick = { tab = item },
                        icon = { Icon(item.icon, contentDescription = item.title) },
                        label = { Text(item.title) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().background(Color(0xFFF7F9FC))) {
            when (tab) {
                Tab.Agents -> AgentsScreen(state, model::select)
                Tab.Chat -> ChatScreen(state, model::send)
                Tab.Board -> BoardScreen(state)
                Tab.Coder -> CoderScreen(state)
                Tab.Settings -> SettingsScreen(state, model::updateInstructions, model::saveInstructions, model::signOut)
            }
            if (state.loading) {
                CircularProgressIndicator(Modifier.align(Alignment.TopEnd).padding(18.dp).size(24.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PagsTopBar(state: PagsState, refresh: () -> Unit) {
    TopAppBar(
        title = {
            Column {
                Text("ProAgentStore", fontWeight = FontWeight.Bold)
                Text(state.user?.displayName ?: state.user?.login ?: "Native agent control", style = MaterialTheme.typography.bodySmall)
            }
        },
        actions = {
            IconButton(onClick = refresh) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color(0xFFF7F9FC)),
    )
}

@Composable
private fun SignInScreen(state: PagsState, signIn: (String) -> Unit) {
    var token by remember { mutableStateOf("") }
    Surface(Modifier.fillMaxSize(), color = Color(0xFFF7F9FC)) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.Center) {
            Icon(Icons.Filled.Bolt, contentDescription = null, tint = Color(0xFF6C3BFF), modifier = Modifier.size(58.dp))
            Spacer(Modifier.height(20.dp))
            Text("ProAgentStore", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text("Native control for private AI agents, chat, boards, and coding sessions.", color = Color(0xFF526070))
            Spacer(Modifier.height(24.dp))
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text("PAGS session token") },
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            Button(onClick = { signIn(token) }, enabled = token.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Filled.AccountCircle, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Sign in")
            }
            Text("Use a ProAgentStore session token from your account. Tokens are stored only on this device.", style = MaterialTheme.typography.bodySmall, color = Color(0xFF6E7782), modifier = Modifier.padding(top = 12.dp))
            state.error?.let { ErrorText(it) }
        }
    }
}

@Composable
private fun AgentsScreen(state: PagsState, select: (String) -> Unit) {
    ScreenColumn {
        SectionTitle("Agents")
        if (state.instances.isEmpty()) {
            EmptyPanel("No subscribed instances yet", "Subscribe to agents on ProAgentStore, then refresh.")
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(state.instances) { instance ->
                    Card(
                        onClick = { select(instance.id) },
                        colors = CardDefaults.cardColors(containerColor = if (state.selected?.id == instance.id) Color(0xFFE9F7EF) else Color.White),
                    ) {
                        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(42.dp).clip(CircleShape).background(Color(0xFF6C3BFF)), contentAlignment = Alignment.Center) {
                                Icon(Icons.Filled.Bolt, contentDescription = null, tint = Color.White)
                            }
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(instance.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(instance.agentName, color = Color(0xFF6E7782), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            AssistChip(onClick = {}, label = { Text(instance.status) })
                        }
                    }
                }
            }
        }
        state.error?.let { ErrorText(it) }
    }
}

@Composable
private fun ChatScreen(state: PagsState, send: (String) -> Unit) {
    var draft by remember { mutableStateOf("") }
    ScreenColumn {
        SectionTitle(state.selected?.name ?: "Chat")
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (state.messages.isEmpty()) {
                item { EmptyPanel("No messages loaded", "Send a message to the selected private agent instance.") }
            }
            items(state.messages) { message ->
                val mine = message.role == "user"
                Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
                    Surface(
                        color = if (mine) Color(0xFF6C3BFF) else Color.White,
                        shape = RoundedCornerShape(8.dp),
                        shadowElevation = 1.dp,
                        modifier = Modifier.fillMaxWidth(0.86f),
                    ) {
                        Text(message.content, color = if (mine) Color.White else Color(0xFF18212B), modifier = Modifier.padding(12.dp))
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(value = draft, onValueChange = { draft = it }, modifier = Modifier.weight(1f), label = { Text("Message agent") })
            Spacer(Modifier.width(8.dp))
            Button(onClick = { send(draft); draft = "" }, enabled = draft.isNotBlank() && state.selected != null) { Text("Send") }
        }
    }
}

@Composable
private fun BoardScreen(state: PagsState) {
    ScreenColumn {
        SectionTitle("Board")
        if (state.tasks.isEmpty()) {
            EmptyPanel("No board tasks", "Runtime tasks will appear here when the agent starts work.")
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(state.tasks) { task ->
                    Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                        Column(Modifier.padding(14.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(task.title, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                                AssistChip(onClick = {}, label = { Text(task.status) })
                            }
                            if (task.summary.isNotBlank()) Text(task.summary, color = Color(0xFF526070))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CoderScreen(state: PagsState) {
    ScreenColumn {
        SectionTitle("Coder")
        EmptyPanel(
            title = state.selected?.agentName ?: "No selected agent",
            body = "Coding sessions and approvals are managed by the selected private runtime instance.",
        )
    }
}

@Composable
private fun SettingsScreen(state: PagsState, update: (String) -> Unit, save: () -> Unit, signOut: () -> Unit) {
    ScreenColumn {
        SectionTitle("Settings")
        OutlinedTextField(
            value = state.instructions,
            onValueChange = update,
            label = { Text("Special instructions") },
            minLines = 5,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(10.dp))
        Button(onClick = save, enabled = state.selected != null) {
            Icon(Icons.Filled.Save, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("Save instructions")
        }
        Spacer(Modifier.height(20.dp))
        Button(onClick = signOut, colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2E3742))) {
            Text("Sign out")
        }
    }
}

@Composable
private fun ScreenColumn(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
}

@Composable
private fun EmptyPanel(title: String, body: String) {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold)
            Text(body, color = Color(0xFF6E7782), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun ErrorText(message: String) {
    Text(message, color = Color(0xFFB42318), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun PagsTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = androidx.compose.material3.lightColorScheme(
            primary = Color(0xFF6C3BFF),
            secondary = Color(0xFF0E8F5A),
            background = Color(0xFFF7F9FC),
            surface = Color.White,
        ),
        content = content,
    )
}
