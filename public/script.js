// public/script.js — версия для Vercel (polling)

// --- Идентификация клиента ---
let myClientId = localStorage.getItem('clientId');
if (!myClientId) {
    // Генерируем UUID или простой ID
    myClientId = crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('clientId', myClientId);
}

let myName = localStorage.getItem('userName');
let mySeatId = null; // будет определено после загрузки

// --- Элементы DOM ---
const userInfoDiv = document.getElementById('user-info');
const releaseBtn = document.getElementById('release-my-seat');

// --- Состояние последних полученных данных (чтобы избежать лишних перерисовок) ---
let lastSeatsData = null;

// --- Функция загрузки имени пользователя с сервера ---
async function loadUserName() {
    try {
        const response = await fetch(`/api/user?clientId=${myClientId}`);
        const data = await response.json();
        if (data.name) {
            myName = data.name;
            localStorage.setItem('userName', myName);
            userInfoDiv.textContent = `Вы: ${myName}`;
        } else {
            userInfoDiv.textContent = 'Вы не представились';
        }
    } catch (err) {
        console.error('Ошибка загрузки имени:', err);
        userInfoDiv.textContent = 'Ошибка загрузки';
    }
}

// --- Функция получения состояния мест с сервера ---
async function fetchSeats() {
    try {
        const response = await fetch('/api/seats');
        if (!response.ok) throw new Error('Ошибка загрузки мест');
        const seats = await response.json();
        return seats;
    } catch (err) {
        console.error('fetchSeats error:', err);
        return null;
    }
}

// --- Функция обновления интерфейса (рендер) ---
function renderSeats(seats) {
    if (!seats) return;

    // Очищаем все блоки
    document.querySelectorAll('.seats-grid').forEach(grid => grid.innerHTML = '');

    // Сбросим mySeatId, потом определим заново
    mySeatId = null;

    seats.forEach(seat => {
        const seatElement = document.createElement('div');
        seatElement.className = 'seat';
        if (seat.occupied) {
            seatElement.classList.add('occupied');
        }
        // Проверяем, принадлежит ли стол текущему пользователю
        if (seat.clientId === myClientId) {
            seatElement.classList.add('my-seat');
            mySeatId = seat.id;
        }

        seatElement.dataset.id = seat.id;
        seatElement.innerHTML = `
            <div>${seat.label}</div>
            ${seat.occupied ? `<div class="user-name">${seat.userName}</div>` : '<div class="user-name">Свободно</div>'}
        `;

        seatElement.addEventListener('click', () => onSeatClick(seat.id, seat.occupied));
        document.querySelector(`.seats-grid[data-block="${seat.block}"]`).appendChild(seatElement);
    });

    // Показываем/скрываем кнопку освобождения
    if (mySeatId) {
        releaseBtn.style.display = 'block';
    } else {
        releaseBtn.style.display = 'none';
    }
}

// --- Основная функция обновления данных (fetch + render) ---
async function refreshSeats() {
    const seats = await fetchSeats();
    if (seats) {
        // Сравниваем с предыдущими данными, чтобы избежать лишних перерисовок (опционально)
        if (JSON.stringify(seats) !== JSON.stringify(lastSeatsData)) {
            lastSeatsData = seats;
            renderSeats(seats);
        }
    }
}

// --- Обработчик клика по столу ---
async function onSeatClick(seatId, occupied) {
    if (occupied) {
        alert('Это место уже занято');
        return;
    }

    // Если пользователь уже занимает стол, предложим освободить
    if (mySeatId) {
        const confirmMove = confirm('Вы уже занимаете другое место. Хотите освободить его и занять это?');
        if (!confirmMove) return;
    }

    // Если имя неизвестно, запросим
    if (!myName) {
        const name = prompt('Введите ваше имя (ФИО):');
        if (!name) return;
        myName = name;
        localStorage.setItem('userName', myName);
        // Сохраняем на сервере
        try {
            await fetch('/api/user', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId: myClientId, name: myName })
            });
        } catch (err) {
            alert('Ошибка сохранения имени');
            return;
        }
    }

    // Отправляем запрос на занятие
    try {
        const response = await fetch('/api/occupy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: myClientId, seatId, name: myName })
        });

        if (!response.ok) {
            const error = await response.json();
            alert('Ошибка: ' + (error.error || 'Не удалось занять место'));
        } else {
            // Сервер возвращает обновлённый список мест — используем его
            const updatedSeats = await response.json();
            lastSeatsData = updatedSeats;
            renderSeats(updatedSeats);
        }
    } catch (err) {
        alert('Ошибка соединения с сервером');
    }
}

// --- Обработчик кнопки освобождения ---
releaseBtn.addEventListener('click', async () => {
    if (!mySeatId) return;
    const confirmRelease = confirm('Освободить ваше текущее место?');
    if (!confirmRelease) return;

    try {
        const response = await fetch('/api/occupy', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: myClientId })
        });

        if (!response.ok) {
            alert('Ошибка при освобождении');
        } else {
            const updatedSeats = await response.json();
            lastSeatsData = updatedSeats;
            renderSeats(updatedSeats);
        }
    } catch (err) {
        alert('Ошибка соединения с сервером');
    }
});

// --- Polling: периодически опрашиваем сервер на предмет изменений ---
let pollInterval = 3000; // 3 секунды
let pollTimer = setInterval(refreshSeats, pollInterval);

// При выходе со страницы очищаем интервал (хороший тон)
window.addEventListener('beforeunload', () => {
    clearInterval(pollTimer);
});

// --- Инициализация при загрузке страницы ---
(async function init() {
    await loadUserName();
    await refreshSeats(); // первый рендер
})();